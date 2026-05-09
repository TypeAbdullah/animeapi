import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";

const BASE_URL = "https://animehindidubbed.in";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_CORS_HEADERS = {
  Referer: BASE_URL,
  Origin: BASE_URL,
  "User-Agent": UA,
};

async function fetchPage(url: string, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", Referer: BASE_URL },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e as Error; }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2 ** i * 500));
  }
  throw lastErr!;
}

export async function getHome() {
  const res = await fetchPage(BASE_URL);
  const html = await res.text();
  const $ = cheerio.load(html);
  const featured: any[] = [];
  $("figure.wp-caption").each((_, fig) => {
    const link = $(fig).find("a").attr("href");
    const img = $(fig).find("img").attr("src") || $(fig).find("img").attr("data-lazy-src");
    const caption = $(fig).find("figcaption").text().trim();
    const slug = link?.match(/animehindidubbed\.in\/([^\/]+)/)?.[1];
    if (link && slug) featured.push({ title: caption || slug.replace(/-/g, " "), slug, poster: img, url: link });
  });
  return { featured };
}

export async function getCategory(name: string) {
  const res = await fetchPage(`${BASE_URL}/category/${name}/`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const anime: any[] = [];
  $("article").each((_, a) => {
    const title = $(a).find("a").first().text().trim();
    const link = $(a).find("a").first().attr("href");
    const img = $(a).find("img").attr("src") || $(a).find("img").attr("data-lazy-src");
    const slug = link?.match(/animehindidubbed\.in\/([^\/]+)/)?.[1];
    if (title && slug) anime.push({ title, slug, poster: img, url: link });
  });
  return { category: name, anime };
}

export async function search(title: string) {
  const res = await fetchPage(`${BASE_URL}/?s=${encodeURIComponent(title)}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const animeList: any[] = [];
  $("article, .post, .type-post").each((_, el) => {
    const titleEl = $(el).find(".entry-title a, .post-title a, h2 a").first();
    const t = titleEl.text().trim();
    const link = titleEl.attr("href");
    const img = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || $(el).find("img").attr("data-lazy-src");
    const slug = link?.match(/animehindidubbed\.in\/([^/]+)\/?/)?.[1];
    if (t && link && slug) animeList.push({ title: t, slug, url: link, thumbnail: img });
  });
  Logger.info(`[HindiDubbed] Search "${title}": ${animeList.length} results`);
  return { animeList, totalFound: animeList.length };
}

export async function getAnime(slug: string) {
  const res = await fetchPage(`${BASE_URL}/${slug}/`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $("article h1.entry-title, .entry-header h1, main h1.entry-title, h1.entry-title").first().text().trim() || slug.replace(/-/g, " ");
  const thumbnail = $('img[src*="wp-content"]').first().attr("src") || $('meta[property="og:image"]').attr("content");
  const description = $("#short-desc").text().trim() || $("article .entry-content p").first().text().trim() || $('meta[property="og:description"]').attr("content");

  const servers: Record<string, Array<{ name: string; url: string }>> = { filemoon: [], servabyss: [], vidgroud: [] };
  $("script").each((_, s) => {
    const sc = $(s).html() || "";
    if (!sc.includes("serverVideos")) return;
    const m = sc.match(/const\s+serverVideos\s*=\s*({[\s\S]*?})\s*;/);
    if (!m) return;
    try {
      const normalized = m[1]
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/'/g, '"');
      const d = JSON.parse(normalized);
      if (d.filemoon) servers.filemoon = d.filemoon;
      if (d.servabyss) servers.servabyss = d.servabyss;
      if (d.vidgroud) servers.vidgroud = d.vidgroud;
    } catch {
      try {
        const d = new Function(`return (${m[1]});`)();
        if (d?.filemoon) servers.filemoon = d.filemoon;
        if (d?.servabyss) servers.servabyss = d.servabyss;
        if (d?.vidgroud) servers.vidgroud = d.vidgroud;
      } catch {}
    }
  });

  const episodeMap = new Map<number, any>();
  const addToMap = (list: Array<{ name: string; url: string }>, serverName: string) => {
    list.forEach(item => {
      const se = item.name.match(/S(\d+)E(\d+)/i);
      const num = se ? parseInt(se[2]) : parseInt(item.name.match(/(\d+)/)?.[1] || "0");
      if (!num) return;
      if (!episodeMap.has(num)) episodeMap.set(num, { number: num, title: `Episode ${num}`, servers: [] });
      episodeMap.get(num)!.servers.push({
        name: serverName,
        url: item.url,
        language: "Hindi",
        cors: true,
        headers: DEFAULT_CORS_HEADERS,
      });
    });
  };
  addToMap(servers.filemoon, "Filemoon");
  addToMap(servers.servabyss, "Servabyss");
  addToMap(servers.vidgroud, "Vidgroud");

  return {
    title, slug, thumbnail, description,
    episodes: Array.from(episodeMap.values()).sort((a, b) => a.number - b.number),
    cors: true,
    headers: DEFAULT_CORS_HEADERS,
  };
}

async function fetchText(url: string, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: referer || BASE_URL,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });
  return res.text();
}

function extractM3u8FromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];
  const normalized = matches.map((m) => m.replace(/\\\//g, "/"));
  return Array.from(new Set(normalized));
}

export async function extractEpisodeHls(sourceUrl: string) {
  if (!sourceUrl) {
    return { sourceUrl, hls: [], inspected: [], note: "Missing source URL" };
  }

  if (/servabyss/i.test(sourceUrl)) {
    return {
      sourceUrl,
      hls: [],
      inspected: [sourceUrl],
      skipped: true,
      note: "Servabyss extraction is intentionally skipped",
      cors: true,
      headers: DEFAULT_CORS_HEADERS,
    };
  }

  const inspected: string[] = [sourceUrl];
  const hls = new Set<string>();

  const html = await fetchText(sourceUrl, BASE_URL);
  extractM3u8FromText(html).forEach((u) => hls.add(u));

  const $ = cheerio.load(html);
  const scriptBlob = $("script").map((_, s) => $(s).html() || "").get().join("\n");
  extractM3u8FromText(scriptBlob).forEach((u) => hls.add(u));

  // Follow a few embedded player/frame URLs and inspect for HLS endpoints.
  const candidates = new Set<string>();
  $("iframe[src], script[src], source[src], video source[src], a[href]").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("href");
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) return;
    if (/\.(js|css|png|jpg|jpeg|svg|woff2?)(\?|$)/i.test(raw)) return;
    candidates.add(raw);
  });

  for (const candidate of Array.from(candidates).slice(0, 12)) {
    if (/servabyss/i.test(candidate)) continue;
    try {
      inspected.push(candidate);
      const content = await fetchText(candidate, sourceUrl);
      extractM3u8FromText(content).forEach((u) => hls.add(u));
    } catch {
      // ignore failed candidate fetch
    }
  }

  return {
    sourceUrl,
    hls: Array.from(hls),
    inspected,
    cors: true,
    headers: DEFAULT_CORS_HEADERS,
  };
}
