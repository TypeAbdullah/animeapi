import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";

const BASE_URL = "https://watchanimeworld.net";
const HLS_CDN_BASE = "https://hlsx3cdn.echovideo.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: BASE_URL,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { Logger.warn(`[ToonWorld] HTTP ${res.status} for ${url}`); return null; }
    return res.text();
  } catch (e: any) {
    Logger.warn(`[ToonWorld] Fetch failed for ${url}: ${e.message}`);
    return null;
  }
}

export async function getEpisodeSources(animeSlug: string, season: number, episode: number) {
  const episodeSlug = `${animeSlug}-${season}x${episode}`;
  const pageUrl = `${BASE_URL}/episode/${episodeSlug}/`;
  Logger.info(`[ToonWorld] Episode: ${pageUrl}`);

  const sources: any[] = [];

  // Direct HLS (EchoVideo CDN)
  sources.push({
    provider: "EchoVideo CDN (Hard Subs)",
    url: `${HLS_CDN_BASE}/${animeSlug}/${episode}/master.m3u8`,
    type: "hls",
    isM3U8: true,
    quality: "HD",
  });

  // Iframe extraction from page
  const html = await fetchPage(pageUrl);
  if (html) {
    const $ = cheerio.load(html);
    const iframeSources: string[] = [];

    $("iframe[allowfullscreen], iframe[src]").each((_, el) => {
      const src = $(el).attr("src") || "";
      if (src && !src.startsWith("#") && !src.startsWith("javascript")) iframeSources.push(src);
    });
    $("iframe[data-src]").each((_, el) => {
      const src = $(el).attr("data-src") || "";
      if (src) iframeSources.push(src);
    });

    // Direct m3u8 in scripts
    const scriptContent = $("script").map((_, el) => $(el).html() || "").get().join("\n");
    const m3u8 = scriptContent.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/);
    if (m3u8) {
      sources.push({ provider: "ToonWorld4ALL (Direct)", url: m3u8[1], type: "hls", isM3U8: true, quality: "HD" });
    }

    // watchanimeworld stores player links in base64-encoded payloads
    const b64Payloads = scriptContent.match(/[A-Za-z0-9+/]{80,}={0,2}/g) || [];
    for (const payload of b64Payloads.slice(0, 20)) {
      try {
        const decoded = atob(payload);
        const parsed = JSON.parse(decoded);
        if (!Array.isArray(parsed)) continue;
        parsed.forEach((entry: any, idx: number) => {
          const link = entry?.link;
          if (!link || typeof link !== "string") return;
          sources.push({
            provider: `ToonWorld4ALL [Server ${idx + 1}]`,
            url: link,
            type: link.includes(".m3u8") ? "hls" : "iframe",
            isM3U8: link.includes(".m3u8"),
          });
        });
      } catch {
        // ignore non-json base64 blobs
      }
    }

    const seen = new Set<string>();
    iframeSources.forEach((src, idx) => {
      if (seen.has(src)) return;
      seen.add(src);
      sources.push({
        provider: idx === 0 ? "ToonWorld4ALL" : `ToonWorld4ALL [Mirror ${idx + 1}]`,
        url: src,
        type: "iframe",
        isM3U8: false,
      });
    });
  }

  return { slug: episodeSlug, season, episode, pageUrl, sources };
}

export async function search(q: string) {
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(q)}`;
  const html = await fetchPage(searchUrl);
  if (!html) return [];

  const $ = cheerio.load(html);
  const results: Array<{ title: string; slug: string; url: string }> = [];
  const isNoise = (title: string, url: string): boolean => {
    const t = title.toLowerCase().trim();
    if (!t || t.length < 3) return true;
    if (["home", "movies", "series", "anime", "cartoon", "view more", "menu"].includes(t)) return true;
    if (/\/category\/|\/letter\/|\/tag\//i.test(url)) return true;
    return false;
  };

  $(".search-wrap article, .c-tabs-item__content, article.item-thumb, article.post").each((_, el) => {
    const titleEl = $(el).find(".post-title a, h3 a, .h2 a, .entry-title a, a[href*='/series/'], a[href*='/movies/']").first();
    const rawTitle = titleEl.text().trim();
    const url = titleEl.attr("href") || "";
    const slugFromUrl = url.match(/\/(?:series|movies|anime)\/([^/]+)/)?.[1] || "";
    const title = rawTitle || (slugFromUrl ? slugFromUrl.replace(/-/g, " ") : "");
    if (title && url && !isNoise(title, url)) {
      const slug = slugFromUrl || slugify(title);
      results.push({ title, slug, url });
    }
  });

  // Fallback
  if (results.length === 0) {
    $("a[href*='/series/'], a[href*='/movies/'], a[href*='/anime/']").each((_, el) => {
      const url = $(el).attr("href") || "";
      const m = url.match(/\/(?:series|movies|anime)\/([^/]+)/);
      const title = $(el).text().trim() || $(el).attr("title") || (m?.[1] ? m[1].replace(/-/g, " ") : "");
      if (title && url && !isNoise(title, url) && !results.some(r => r.url === url)) {
        results.push({ title, slug: m?.[1] || slugify(title), url });
      }
    });
  }

  return results.slice(0, 10);
}
