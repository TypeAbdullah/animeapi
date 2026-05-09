import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";

const BASE_URL = "https://www.desidubanime.me";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function cleanText(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string | undefined | null): string {
  if (!value) return "";
  const $ = cheerio.load(`<div>${value}</div>`);
  return cleanText($("div").text());
}

async function fetchHtml(paths: string[]): Promise<string> {
  let lastErr: Error | null = null;
  for (const path of paths) {
    try {
      const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
      const res = await fetchRetry(url);
      const html = await res.text();
      if (html && !/coosync\.com|adsboosters|widescreensponsor/i.test(html)) {
        return html;
      }
      lastErr = new Error("Blocked/redirect response");
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr || new Error("Failed to fetch page");
}

async function fetchRetry(url: string, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return res;
      if (res.status === 404) throw new Error("Status 404");
      throw new Error(`Status ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message === "Status 404") throw e;
      lastErr = e as Error;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr!;
}

export async function getHome() {
  const html = await fetchHtml(["/home", "/", "/az-list/"]);
  const $ = cheerio.load(html);
  const featured: any[] = [];

  $(".swiper-slide, article.post, .latest-episodes article, a[href*='/anime/']").each((_, el) => {
    const a = $(el).is("a") ? $(el) : $(el).find("a").first();
    let title = cleanText(
      $(el).find("h2 span[data-en-title]").text() ||
      $(el).find("h1, h2, h3, .entry-title").first().text() ||
      a.attr("title")
    );
    const url = a.attr("href");
    const img = $(el).find("img").attr("data-src") || $(el).find("img").attr("src");
    let slug = "";
    if (url) {
      const m = url.match(/\/(?:anime|series)\/([^/]+)\/?$/);
      if (m) slug = m[1];
    }
    if (!title && slug) {
      title = cleanText(slug.replace(/[-_]+/g, " "));
    }
    if (title && slug && url) featured.push({ title, slug, url, poster: img, type: "series" });
  });

  const unique = Array.from(new Map(featured.map(i => [i.slug, i])).values()).slice(0, 20);
  return { featured: unique };
}

export async function search(q: string) {
  // Primary source: WordPress anime post type API (fast + reliable)
  try {
    const apiRes = await fetchRetry(
      `${BASE_URL}/wp-json/wp/v2/anime?search=${encodeURIComponent(q)}&per_page=30&_embed=1`
    );
    const apiJson = (await apiRes.json()) as any[];
    if (Array.isArray(apiJson) && apiJson.length > 0) {
      const results = apiJson
        .map((item) => {
          const title = decodeHtmlEntities(item?.title?.rendered || item?.slug || "");
          const slug = String(item?.slug || "");
          const url = String(item?.link || `${BASE_URL}/anime/${slug}/`);
          const poster =
            item?._embedded?.["wp:featuredmedia"]?.[0]?.source_url ||
            item?._embedded?.["wp:featuredmedia"]?.[0]?.media_details?.sizes?.medium?.source_url ||
            "";
          return title && slug ? { title, slug, url, poster } : null;
        })
        .filter(Boolean);

      if (results.length > 0) return { results };
    }
  } catch {
    // fall back to HTML scraping below
  }

  const html = await fetchHtml([
    `/?s=${encodeURIComponent(q)}`,
    `/search?s_keyword=${encodeURIComponent(q)}`,
  ]);
  const $ = cheerio.load(html);
  const results: any[] = [];

  $("article.post, article, .search-page article, a[href*='/anime/']").each((_, el) => {
    const a = $(el).is("a") ? $(el) : $(el).find("a.lnk-blk, .entry-title a, h2 a, h3 a, a[href*='/anime/']").first();
    const title = cleanText($(el).find(".entry-title").text() || a.text() || a.attr("title"));
    const url = a.attr("href");
    const img = $(el).find("img").attr("data-src") || $(el).find("img").attr("src");
    let slug = "";
    if (url) {
      const m = url.match(/\/(?:anime|series)\/([^/]+)\/?$/);
      if (m) slug = m[1];
    }
    if (title && slug) results.push({ title, slug, url, poster: img });
  });

  return { results };
}

export async function getInfo(id: string) {
  const html = await fetchHtml([`/anime/${id}/`, `/series/${id}/`]);
  const $ = cheerio.load(html);

  const title = cleanText($("h1").first().text() || $('meta[property="og:title"]').attr("content") || id.replace(/[-_]+/g, " "));
  const poster = $(".anime-image img").attr("data-src") || $(".anime-image img").attr("src");
  const synopsis = cleanText(
    $("[data-synopsis]").text() ||
    $(".anime-synopsis, .entry-content p, .description").first().text() ||
    $('meta[property="og:description"]').attr("content")
  );
  const episodes: any[] = [];

  // Primary: swiper carousel
  $(".swiper-episode-anime .swiper-slide a").each((_, el) => {
    const epUrl = $(el).attr("href");
    const epTitle = cleanText($(el).attr("title") || $(el).find(".episode-list-item-title").text());
    const epNumStr =
      $(el).find(".episode-list-item-number").text().trim() ||
      $(el).find("span").text().replace("Episode", "").trim();
    if (epUrl) {
      const m = epUrl.match(/\/watch\/([^/]+)\/?/);
      const epId = m ? m[1] : "";
      const epNumFromUrl = epUrl.match(/episode-(\d+)/i)?.[1];
      const epImage = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      const parsedNum = parseFloat(epNumStr || epNumFromUrl || "0") || 0;
      episodes.push({
        id: epId,
        number: parsedNum,
        title: epTitle && !/^watch\s*now$/i.test(epTitle) ? epTitle : `Episode ${parsedNum || epNumFromUrl || "1"}`,
        url: epUrl,
        image: epImage,
      });
    }
  });

  // Fallback
  if (episodes.length === 0) {
    $(".episode-list-display-box a, a[href*='/watch/']").each((_, el) => {
      const epUrl = $(el).attr("href");
      if (!epUrl || !epUrl.includes("/watch/")) return;
      const epNum =
        $(el).find(".episode-list-item-number").text().trim() ||
        $(el).text().match(/episode\s*(\d+)/i)?.[1] ||
        epUrl.match(/episode-(\d+)/i)?.[1];
      const epTitle = $(el).find(".episode-list-item-title").text().trim() || $(el).attr("title") || $(el).text().trim();
      const m = epUrl.match(/\/watch\/([^/]+)\/?/);
      const epId = m ? m[1] : "";
      if (epId) {
        const parsedNum = parseFloat(epNum || "0") || 0;
        episodes.push({
          id: epId,
          number: parsedNum,
          title: epTitle && !/^watch\s*now$/i.test(epTitle) ? epTitle : `Episode ${parsedNum || "1"}`,
          url: epUrl,
        });
      }
    });
  }

  // Last fallback for pages that list episodes in plain anchor blocks
  if (episodes.length <= 1) {
    $("a[href*='/watch/']").each((_, el) => {
      const epUrl = $(el).attr("href");
      if (!epUrl) return;
      const epId = epUrl.match(/\/watch\/([^/]+)\/?/)?.[1] || "";
      const epNum = parseFloat(epUrl.match(/episode-(\d+)/i)?.[1] || "0");
      const rawText = cleanText($(el).text());
      if (!epId || !epNum) return;
      episodes.push({
        id: epId,
        number: epNum,
        title: rawText && !/^watch\s*now$/i.test(rawText) ? rawText : `Episode ${epNum}`,
        url: epUrl,
      });
    });
  }

  // Related seasons
  const seasons: any[] = [];
  $("a[href*='/anime/']").filter((_, el) => {
    const t = $(el).text().toLowerCase();
    return t.includes("season") || t.includes("s1") || t.includes("s2");
  }).each((_, el) => {
    const seasonUrl = $(el).attr("href");
    const seasonTitle = $(el).text().trim();
    const m = seasonUrl?.match(/\/anime\/([^/]+)\/?/);
    const seasonSlug = m ? m[1] : "";
    if (seasonSlug && seasonTitle) seasons.push({ id: seasonSlug, title: seasonTitle, url: seasonUrl });
  });

  // Downloads
  const downloads: any[] = [];
  $("a[href*='drive.google'], a[href*='download']").each((_, el) => {
    const downloadUrl = $(el).attr("href");
    const m = $(el).text().trim().match(/(\d+p|480p|720p|1080p)/i);
    const quality = m ? m[1].toUpperCase() : "Unknown";
    if (downloadUrl) downloads.push({ quality, url: downloadUrl });
  });

  return {
    id,
    title,
    poster,
    description: synopsis,
    episodes: Array.from(new Map(episodes.map((ep) => [ep.id, ep])).values()).sort((a, b) => a.number - b.number),
    seasons: seasons.length > 0 ? seasons : undefined,
    downloads: downloads.length > 0 ? downloads : undefined,
  };
}

export async function watch(id: string) {
  Logger.info(`[DesiDubAnime] Fetching watch: ${BASE_URL}/watch/${id}/`);
  const html = await fetchHtml([`/watch/${id}/`]);
  const $ = cheerio.load(html);
  const sources: any[] = [];

  const decodeB64 = (str: string) => { try { return atob(str); } catch { return ""; } };

  // Primary: data-embed-id
  $("span[data-embed-id]").each((_, el) => {
    const embedData = $(el).attr("data-embed-id");
    if (!embedData) return;
    const [b64Name, b64Url] = embedData.split(":");
    if (!b64Name || !b64Url) return;
    const serverName = decodeB64(b64Name);
    let finalUrl = decodeB64(b64Url);
    if (!finalUrl || !serverName) return;
    if (finalUrl.includes("<iframe")) {
      const m = finalUrl.match(/src=['"]([^'"]+)['"]/);
      if (m) finalUrl = m[1];
    }
    if (finalUrl && !finalUrl.includes("googletagmanager")) {
      const isDub = serverName.toLowerCase().includes("dub");
      sources.push({
        name: serverName.replace(/dub$/i, ""),
        url: finalUrl,
        isM3U8: finalUrl.includes(".m3u8"),
        isEmbed: !finalUrl.includes(".m3u8"),
        category: isDub ? "dub" : "sub",
        language: isDub ? "Hindi" : "Japanese",
      });
    }
  });

  // Fallback: iframes
  if (sources.length === 0) {
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src && !src.includes("googletagmanager") && !src.includes("cdn-cgi")) {
        sources.push({
          name: "Default",
          url: src,
          isM3U8: src.includes(".m3u8"),
          isEmbed: true,
          category: "dub",
        });
      }
    });
  }

  // Fallback: extract direct links from scripts
  if (sources.length === 0) {
    const scriptBlob = $("script").map((_, el) => $(el).html() || "").get().join("\n");
    const urlMatches = scriptBlob.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const seen = new Set<string>();
    for (const raw of urlMatches) {
      const u = raw.replace(/\\\//g, "/");
      if (seen.has(u) || /googletagmanager|google-analytics|doubleclick|cdn-cgi/i.test(u)) continue;
      if (!/m3u8|mp4|embed|player|stream|watch/i.test(u)) continue;
      seen.add(u);
      sources.push({
        name: u.includes("m3u8") ? "Direct" : "Embed",
        url: u,
        isM3U8: u.includes(".m3u8"),
        isEmbed: !u.includes(".m3u8"),
        category: "dub",
        language: "Hindi",
      });
    }
  }

  return {
    sources,
    headers: { Referer: BASE_URL, "User-Agent": UA },
  };
}
