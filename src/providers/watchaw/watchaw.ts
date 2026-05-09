import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";

const BASE_URL_WAW = "https://watchanimeworld.net";
const UA_WAW = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const LANGUAGE_NAMES: Record<string, { name: string; code: string; isDub: boolean }> = {
  hindi: { name: "Hindi", code: "hi", isDub: true },
  tamil: { name: "Tamil", code: "ta", isDub: true },
  telugu: { name: "Telugu", code: "te", isDub: true },
  malayalam: { name: "Malayalam", code: "ml", isDub: true },
  bengali: { name: "Bengali", code: "bn", isDub: true },
  marathi: { name: "Marathi", code: "mr", isDub: true },
  kannada: { name: "Kannada", code: "kn", isDub: true },
  english: { name: "English", code: "en", isDub: true },
  japanese: { name: "Japanese", code: "ja", isDub: false },
  korean: { name: "Korean", code: "ko", isDub: true },
  chinese: { name: "Chinese", code: "zh", isDub: true },
};

function normalizeLang(lang: string) {
  const key = lang.toLowerCase().trim();
  return LANGUAGE_NAMES[key] || { name: lang, code: "und", isDub: key !== "japanese" && key !== "jpn" };
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

async function fetchRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.ok || res.status === 206 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e as Error;
      Logger.warn(`[WatchAW] Retry ${i + 1} for ${url}: ${lastErr.message}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2 ** i * 500));
  }
  throw lastErr!;
}

export function parseEpisodeSlug(urlOrSlug: string): { slug: string; animeSlug: string; season: number; episode: number; fullUrl: string } | null {
  try {
    let slug = urlOrSlug;
    let fullUrl = urlOrSlug;
    if (urlOrSlug.startsWith("http")) {
      const u = new URL(urlOrSlug);
      const m = u.pathname.match(/\/episode\/([^/]+)\/?$/);
      if (!m) return null;
      slug = m[1];
    } else {
      fullUrl = `${BASE_URL_WAW}/episode/${slug}/`;
    }
    const m = slug.match(/^(.+?)-(\d+)(?:x|-)(\d+)$/i);
    if (!m) return null;
    const [, animeSlug, seasonStr, episodeStr] = m;
    const season = parseInt(seasonStr, 10);
    const episode = parseInt(episodeStr, 10);
    if (isNaN(season) || isNaN(episode)) return null;
    return { slug, animeSlug, season, episode, fullUrl };
  } catch {
    return null;
  }
}

async function getEpisodeSourcesDirect(episodeIdentifier: string): Promise<any> {
  const parsed = parseEpisodeSlug(episodeIdentifier);
  if (!parsed) throw new Error("Invalid episode URL/slug format");

  Logger.info(`[WatchAW] Fetching directly: ${parsed.fullUrl}`);
  const res = await fetchRetry(parsed.fullUrl, {
    headers: { "User-Agent": UA_WAW, Accept: "text/html,application/xhtml+xml" },
  });
  const html = await res.text();

  const sources: any[] = [];
  let subtitlePayload: any = sources;
  const player1Match = html.match(/iframe[^>]+data-src="([^"]*\/api\/player1\.php\?data=([^"]+))"/i);

  if (player1Match) {
    try {
      const decoded = atob(player1Match[2]);
      const servers = JSON.parse(decoded);
      subtitlePayload = servers;
      const langCounts: Record<string, number> = {};

      for (const server of servers) {
        const language = server.language || "Unknown";
        const link = server.link || "";
        if (!link) continue;

        const lang = normalizeLang(language);
        const lk = lang.name.toUpperCase();
        langCounts[lk] = (langCounts[lk] || 0) + 1;
        const variant = langCounts[lk] === 1 ? "I" : "II";

        const charMap: Record<string, string> = { HINDI: "Goku", TAMIL: "Vegeta", TELUGU: "Gohan", MALAYALAM: "Piccolo", BENGALI: "Trunks", ENGLISH: "Luffy", JAPANESE: "Zoro" };
        const charName = charMap[lk] || "Kira";
        const providerName = `${charName} ${variant} (${lang.code.toUpperCase()})`;

        try {
          const providerRes = await fetchRetry(link, {
            headers: { "User-Agent": UA_WAW, Referer: parsed.fullUrl },
          }, 1);
          const pHtml = await providerRes.text();

          if (pHtml.includes("challenge-platform") || pHtml.includes("Just a moment")) {
            sources.push({ url: link, isM3U8: false, language: lang.name, langCode: lang.code, isDub: lang.isDub, needsHeadless: true, providerName });
            continue;
          }

          const m3u8Matches = pHtml.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi);
          if (m3u8Matches) {
            for (const m3u8 of m3u8Matches.slice(0, 2)) {
              sources.push({ url: m3u8, isM3U8: true, language: lang.name, langCode: lang.code, isDub: lang.isDub, quality: "HD", providerName });
            }
          } else {
            sources.push({ url: link, isM3U8: false, language: lang.name, langCode: lang.code, isDub: lang.isDub, needsHeadless: true, providerName });
          }
        } catch {
          sources.push({ url: link, isM3U8: false, language: lang.name, langCode: lang.code, isDub: lang.isDub, needsHeadless: true, providerName });
        }
      }
    } catch (e) {
      Logger.error(`[WatchAW] Failed parsing player1 data: ${e}`);
    }
  }

  return {
    headers: { Referer: parsed.fullUrl, "User-Agent": UA_WAW },
    sources,
    subtitles: collectSubtitleTracks((subtitlePayload as any)?.subtitles || (subtitlePayload as any)?.data?.subtitles || (subtitlePayload as any)?.tracks || (subtitlePayload as any)?.data?.tracks || sources),
  };
}

export async function getEpisodeSources(episodeIdentifier: string, supabaseUrl?: string, supabaseKey?: string): Promise<any> {
  const parsed = parseEpisodeSlug(episodeIdentifier);
  if (!parsed) throw new Error("Invalid episode URL/slug format");

  if (supabaseUrl && supabaseKey) {
    try {
      Logger.info(`[WatchAW] Fetching via Supabase: ${parsed.slug}`);
      const res = await fetchRetry(`${supabaseUrl}/functions/v1/watchanimeworld-scraper?episodeUrl=${parsed.slug}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          apikey: supabaseKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "CoorenProxy" }),
      });
      return await res.json();
    } catch (e) {
      Logger.warn(`[WatchAW] Supabase failed, falling back to direct: ${e}`);
    }
  }

  return getEpisodeSourcesDirect(episodeIdentifier);
}

export async function getHome(): Promise<any> {
  const res = await fetchRetry(BASE_URL_WAW, {
    headers: { "User-Agent": UA_WAW, Accept: "text/html" },
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const featured: any[] = [];

  $(".latest-ep-swiper-slide article.post, article.post.movies, article.post, .swiper-slide article").each((_, el) => {
    const title = $(el).find(".entry-title, h2, h3").first().text().trim();
    const link = $(el).find("a.lnk-blk, .entry-title a, a[href*='/series/'], a[href*='/movies/'], a[href*='/episode/']").first().attr("href");
    const img = $(el).find("img").attr("src") || $(el).find("img").attr("data-src") || "";
    let slug = "";
    if (link) {
      const m = link.match(/\/(?:series|movies|episode)\/([^/]+)\/?$/);
      if (m) slug = m[1];
    }
    if (title && slug) {
      featured.push({
        title,
        slug,
        seriesSlug: slug,
        url: link,
        poster: img.startsWith("//") ? `https:${img}` : img,
      });
    }
  });

  return { featured: featured.slice(0, 20) };
}

export async function search(q: string): Promise<any> {
  const res = await fetchRetry(`${BASE_URL_WAW}/?s=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": UA_WAW, Accept: "text/html" },
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const results: any[] = [];

  $("article.post").each((_, el) => {
    const title = $(el).find(".entry-title").text().trim();
    const link = $(el).find("a.lnk-blk, a").attr("href");
    const img = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
    let slug = "";
    if (link) {
      const m = link.match(/\/series\/([^/]+)\/?$/) || link.match(/\/anime\/([^/]+)\/?$/);
      if (m) slug = m[1];
    }
    if (title && slug) results.push({ title, slug, url: link, poster: img });
  });

  return { results };
}
