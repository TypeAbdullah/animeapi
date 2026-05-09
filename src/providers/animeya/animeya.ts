import * as cheerio from "cheerio";
// import { Logger } from "../../utils/logger.js"; // removed unused

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_CORS_HEADERS = {
  Referer: "https://animeya.cc",
  Origin: "https://animeya.cc",
  "User-Agent": UA,
};

async function fetchText(url: string, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: referer || "https://animeya.cc",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(30000),
  });
  return res.text();
}

function extractM3u8FromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];
  return Array.from(new Set(matches.map((m) => m.replace(/\\\//g, "/"))));
}

export async function extractEpisodeHls(url: string) {
  if (!url) {
    return { sourceUrl: url, hls: [], inspected: [], cors: true, headers: DEFAULT_CORS_HEADERS, note: "Missing url" };
  }

  const inspected: string[] = [url];
  const hls = new Set<string>();

  const html = await fetchText(url);
  extractM3u8FromText(html).forEach((u) => hls.add(u));

  const $ = cheerio.load(html);
  const scriptBlob = $("script").map((_, s) => $(s).html() || "").get().join("\n");
  extractM3u8FromText(scriptBlob).forEach((u) => hls.add(u));

  $("iframe[src], script[src], source[src], video source[src], a[href]").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("href");
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) return;
    if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ttf|mp4)(\?|$)/i.test(raw)) return;
    inspected.push(raw);
  });

  for (const candidate of Array.from(new Set(inspected)).slice(0, 12)) {
    if (candidate === url) continue;
    try {
      const page = await fetchText(candidate, url);
      extractM3u8FromText(page).forEach((u) => hls.add(u));
    } catch {
      // ignore
    }
  }

  return {
    sourceUrl: url,
    hls: Array.from(hls),
    inspected: Array.from(new Set(inspected)),
    cors: true,
    headers: DEFAULT_CORS_HEADERS,
  };
}

async function fetchRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
        headers: { ...options.headers, "User-Agent": UA },
      });
      if (res.ok) return res;
      if (res.status === 404) throw new Error("Status 404");
      lastErr = new Error(`Status ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message === "Status 404") throw e;
      lastErr = e as Error;
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  throw lastErr!;
}

function parseRSCStream(html: string): any[] {
  const lines: any[] = [];
  const regex = /self\.__next_f\.push\(\[(\d+|0),"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    let raw = m[2];
    try { raw = JSON.parse(`"${raw}"`); } catch {
      raw = raw.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
    if (typeof raw !== "string") continue;
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const val = raw.substring(idx + 1);
    try {
      lines.push(val.trim().startsWith("[") || val.trim().startsWith("{") ? JSON.parse(val) : val);
    } catch { lines.push(val); }
  }
  return lines;
}

function deepSearch(obj: any, pred: (v: any) => boolean, results: any[] = []): any[] {
  if (!obj || typeof obj !== "object") return results;
  try {
    if (pred(obj)) results.push(obj);
    if (Array.isArray(obj)) { for (const x of obj) deepSearch(x, pred, results); }
    else { for (const k in obj) deepSearch(obj[k], pred, results); }
  } catch { }
  return results;
}

function extractCard(node: any): any | null {
  try {
    if (!node.href || typeof node.href !== "string" || !node.href.startsWith("/watch/")) return null;
    const slug = node.href.split("/watch/")[1];
    if (!slug) return null;
    const props: any = { slug, title: "Unknown", cover: "", type: "TV" };
    const coverNode = deepSearch(node, o =>
      (o?.cover && (o.cover.extraLarge || o.cover.large || o.cover.medium)) ||
      (typeof o?.image === "string") ||
      (typeof o?.bannerImage === "string")
    )[0];
    if (coverNode?.cover) props.cover = coverNode.cover.extraLarge || coverNode.cover.large || coverNode.cover.medium || "";
    if (!props.cover && typeof coverNode?.image === "string") props.cover = coverNode.image;
    if (!props.cover && typeof coverNode?.bannerImage === "string") props.cover = coverNode.bannerImage;
    const titleNode = deepSearch(node, o => o?.title && (o.title.english || o.title.romaji))[0];
    if (titleNode) props.title = titleNode.title.english || titleNode.title.romaji || titleNode.title.native;
    if (!props.cover) {
      const serialized = JSON.stringify(node).replace(/\\\//g, "/");
      const m = serialized.match(/https?:\/\/[^"\s]+anilistcdn[^"\s]+\.(?:jpg|jpeg|png|webp)/i);
      if (m) props.cover = m[0];
    }
    if (!props.cover && !props.title) return null;
    return props;
  } catch { return null; }
}

function cleanText(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function collectSubtitleTracks(value: any, fallbackLang = "Subtitles"): Array<{ label: string; url: string; lang?: string; kind?: string; file?: string }> {
  const collected: Array<{ label: string; url: string; lang?: string; kind?: string; file?: string }> = [];
  const seen = new Set<string>();

  const walk = (node: any, inheritedLang?: string) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedLang);
      return;
    }
    if (typeof node !== "object") return;

    const url = node.url || node.src || node.file || node.subtitleUrl || node.subUrl;
    if (typeof url === "string" && url.trim()) {
      const lang = String(node.lang || node.language || node.label || inheritedLang || fallbackLang).trim() || fallbackLang;
      const label = String(node.label || node.name || lang).trim() || lang;
      const key = `${lang}|${label}|${url}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        collected.push({ label, url: url.trim(), lang, kind: node.kind, file: typeof node.file === "string" ? node.file.trim() : url.trim() });
      }
    }

    for (const key of ["subtitles", "subtitle", "tracks", "captions"]) {
      const child = node[key];
      if (child) walk(child, String(node.lang || node.language || node.label || inheritedLang || fallbackLang));
    }
  };

  walk(value);
  return collected;
}

function extractWatchLinksFromHtml(html: string): Array<{ slug: string; title: string }> {
  const links: Array<{ slug: string; title: string }> = [];
  const seen = new Set<string>();
  const linkRegex = /href=["']https?:\/\/animeya\.cc\/watch\/([^"'/]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    links.push({ title: cleanText(slug.replace(/-/g, " ")), slug });
  }
  return links;
}

export async function getHome() {
  const res = await fetchRetry("https://animeya.cc/home");
  const html = await res.text();
  const rscObjects = parseRSCStream(html);
  const cards: any[] = [];
  const seen = new Set<string>();
  for (const obj of rscObjects) {
    deepSearch(obj, o => o?.href && typeof o.href === "string" && o.href.startsWith("/watch/"))
      .forEach(n => {
        const c = extractCard(n);
        if (c && !seen.has(c.slug)) { seen.add(c.slug); cards.push(c); }
      });
  }

  const fromHtml = extractWatchLinksFromHtml(html)
    .map((x) => ({ slug: x.slug, title: x.title, cover: "", type: "TV" }))
    .filter((x) => !seen.has(x.slug));

  const combined = [...cards, ...fromHtml];
  const featured = combined.slice(0, 20);
  const trending = combined.slice(0, 10);
  return { featured, trending };
}

export async function search(q: string) {
  const res = await fetchRetry(`https://animeya.cc/browser?search=${encodeURIComponent(q)}`);
  const html = await res.text();
  const rscObjects = parseRSCStream(html);
  const results: any[] = [];
  const seen = new Set<string>();
  for (const obj of rscObjects) {
    deepSearch(obj, o => o?.href && typeof o.href === "string" && o.href.startsWith("/watch/"))
      .forEach(n => {
        const c = extractCard(n);
        if (c && !seen.has(c.slug)) { seen.add(c.slug); results.push(c); }
      });
  }
  return { results };
}

export async function getInfo(slug: string) {
  const res = await fetchRetry(`https://animeya.cc/watch/${slug}`);
  const html = await res.text();
  const rscObjects = parseRSCStream(html);
  const details: any = { id: slug, title: slug, cover: "", description: "", episodes: [] };
  const htmlTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || "";
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || "";
  const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || "";
  const ogDescription = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || "";
  const metaDescription = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || "";
  const notFoundPage = /404:\s*This page could not be found\./i.test(htmlTitle) || /404:\s*This page could not be found\./i.test(html);

  for (const obj of rscObjects) {
    const epLists = deepSearch(obj, o => Array.isArray(o) && o.length > 0 && typeof o[0]?.episodeNumber === "number");
    if (epLists.length > 0) {
      epLists.sort((a, b) => b.length - a.length);
      details.episodes = epLists[0].map((ep: any) => ({ id: ep.id, number: ep.episodeNumber, title: ep.title, isFiller: ep.isFiller }));
    }
    if (details.title === slug && !notFoundPage) {
      const titleNodes = deepSearch(obj, o => Array.isArray(o) && o[0] === "$" && o[1] === "title");
      if (titleNodes.length > 0) {
        const t = titleNodes[0][3]?.children;
        if (t) details.title = t.replace(" | Animeya", "");
      }
    }
    if (!details.cover) {
      const cn = deepSearch(obj, o => o?.cover && (o.cover.large || o.cover.extraLarge))[0];
      if (cn) details.cover = cn.cover.extraLarge || cn.cover.large;
    }
    if (!details.description) {
      const md = deepSearch(obj, o => Array.isArray(o) && o[0] === "$" && o[1] === "meta" && o[2] === "description");
      if (md.length > 0) details.description = md[0][3]?.content || "";
    }
  }
  const unique = new Map<number, any>();
  details.episodes.forEach((ep: any) => unique.set(ep.number, ep));
  details.episodes = Array.from(unique.values()).sort((a, b) => a.number - b.number);
  if (!details.cover && ogImage) details.cover = ogImage;
  if ((details.title === slug || /404:\s*This page could not be found\./i.test(details.title)) && ogTitle) {
    details.title = ogTitle.replace(/\s*\|\s*Animeya\s*$/i, "");
  }
  if (!details.description) {
    const jsonDesc = html.match(/"description"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)?.[1];
    if (jsonDesc) {
      try {
        details.description = cleanText(JSON.parse(`"${jsonDesc}"`));
      } catch {
        details.description = cleanText(jsonDesc.replace(/\\n/g, " "));
      }
    }
  }
  if (!details.description) {
    details.description = cleanText(ogDescription || metaDescription);
  }
  if (notFoundPage && details.episodes.length === 0) throw new Error("Status 404");
  return details;
}

export async function getEpisodeSources(episodeId: string) {
  const trpcUrl = `https://animeya.cc/api/trpc/episode.getEpisodeFullById?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { "json": parseInt(episodeId, 10) } }))}`;
  const res = await fetchRetry(trpcUrl);
  const json = await res.json() as any;
  const episodeData = json[0]?.result?.data?.json;
  if (!episodeData) throw new Error("Episode not found");
  const sources = (episodeData.players || []).map((p: any) => ({
    name: p.name || "Unknown",
    url: p.url,
    type: p.type || (p.url?.includes(".m3u8") ? "HLS" : "EMBED"),
    quality: p.quality || "720p",
    langue: p.langue || "ENG",
    subType: p.subType || "NONE",
  }));
  const subtitles = [
    ...collectSubtitleTracks(episodeData.subtitles),
    ...collectSubtitleTracks(episodeData.tracks),
    ...collectSubtitleTracks(episodeData.players),
    ...(Array.isArray(episodeData.players)
      ? episodeData.players.flatMap((player: any) => collectSubtitleTracks(player?.subtitles || player?.tracks || player?.captions))
      : []),
  ];
  return { episode: { id: episodeData.id, title: episodeData.title, number: episodeData.episodeNumber }, sources, subtitles };
}
