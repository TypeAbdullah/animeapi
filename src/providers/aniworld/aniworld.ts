import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";

const BASE_URL = "https://aniworld.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchHtml(url: string, retries = 3): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          Referer: BASE_URL,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (e) {
      lastErr = e as Error;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2 ** i * 500));
    }
  }
  throw lastErr!;
}

function normalizeLang(text: string) {
  const l = text.toLowerCase();
  if (l.includes("deutsch") || l.includes("german")) return { name: "German", code: "de", isDub: true };
  if (l.includes("ger-sub") || l.includes("german sub")) return { name: "German Sub", code: "de-sub", isDub: false };
  if (l.includes("englisch") || l.includes("english")) return { name: "English", code: "en", isDub: true };
  if (l.includes("japanisch") || l.includes("japanese")) return { name: "Japanese", code: "ja", isDub: false };
  return { name: text, code: "und", isDub: false };
}

export async function getInfo(slug: string) {
  Logger.info(`[Aniworld] Info: ${BASE_URL}/anime/stream/${slug}`);
  const html = await fetchHtml(`${BASE_URL}/anime/stream/${slug}`);
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    "";
  const description =
    $("[class*='description']").first().text().trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    $("p").filter((_, el) => $(el).text().length > 100).first().text().trim() ||
    "";
  const poster =
    $("img[class*='cover']").attr("src") ||
    $("img[class*='poster']").attr("src") ||
    $("meta[property='og:image']").attr("content") ||
    "";
  const genres: string[] = [];
  $("a[href*='/genre/'], [class*='genre'] a").each((_, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });

  // Seasons
  const seasons: any[] = [];
  $("a[href*='/staffel-']").each((_, link) => {
    const seasonUrl = $(link).attr("href");
    const seasonTitle = $(link).text().trim();
    const m = seasonUrl?.match(/staffel-(\d+)/i);
    const seasonNum = m ? parseInt(m[1], 10) : undefined;
    if (seasonUrl && seasonNum) {
      seasons.push({
        number: seasonNum,
        title: seasonTitle || `Staffel ${seasonNum}`,
        url: seasonUrl.startsWith("http") ? seasonUrl : `${BASE_URL}${seasonUrl}`,
      });
    }
  });

  // Episodes
  const episodes: any[] = [];
  $("table tr, [class*='episode']").each((_, row) => {
    const episodeLink = $(row).find("a[href*='/episode-']").first();
    const episodeUrl = episodeLink.attr("href");
    if (!episodeUrl) return;
    const m = episodeUrl.match(/episode-(\d+)/i);
    const episodeNum = m ? parseInt(m[1], 10) : undefined;
    const episodeTitle =
      episodeLink.text().trim() || $(row).find("td").eq(1).text().trim() || `Episode ${episodeNum}`;
    const languages: string[] = [];
    $(row).find("img[alt*='Deutsch'], img[alt*='German'], img[alt*='English']").each((_, img) => {
      const alt = $(img).attr("alt") || "";
      if (alt) languages.push(alt);
    });
    if (episodeNum) {
      episodes.push({
        number: episodeNum,
        title: episodeTitle,
        url: episodeUrl.startsWith("http") ? episodeUrl : `${BASE_URL}${episodeUrl}`,
        languages: languages.length > 0 ? languages : undefined,
      });
    }
  });

  return {
    slug,
    title,
    description,
    poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
    genres: genres.length > 0 ? genres : undefined,
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes: episodes.length > 0 ? episodes.sort((a, b) => a.number - b.number) : undefined,
  };
}

export async function watch(slug: string, episodeNum: string) {
  // Ensure staffel info — default to staffel-1 if missing
  const fullSlug = slug.includes("staffel-") ? slug : `${slug}/staffel-1`;
  const watchUrl = `${BASE_URL}/anime/stream/${fullSlug}/episode-${episodeNum}`;
  Logger.info(`[Aniworld] Watch: ${watchUrl}`);
  const html = await fetchHtml(watchUrl);
  const $ = cheerio.load(html);

  const title =
    $("h1, h2").filter((_, el) => {
      const t = $(el).text().toLowerCase();
      return t.includes("episode") || t.includes("folge");
    }).first().text().trim() ||
    $("[class*='episode-title']").first().text().trim() ||
    `Episode ${episodeNum}`;

  // Map language keys
  const langMap: Record<string, { name: string; code: string; isDub: boolean }> = {};
  $(".changeLanguageBox img").each((_, img) => {
    const key = $(img).attr("data-lang-key");
    const t = $(img).attr("title") || $(img).attr("alt") || "";
    if (key) langMap[key] = normalizeLang(t);
  });

  const sources: any[] = [];

  $("li[data-lang-key][data-link-target]").each((_, li) => {
    const langKey = $(li).attr("data-lang-key");
    const redirectUrl = $(li).attr("data-link-target");
    const hosterName =
      $(li).find("h4").text().trim() ||
      $(li).find(".icon").attr("title")?.replace("Hoster ", "") ||
      "Unknown";
    if (redirectUrl && langKey) {
      const lang = langMap[langKey] || { name: "Unknown", code: "und", isDub: false };
      sources.push({
        name: hosterName,
        url: redirectUrl.startsWith("http") ? redirectUrl : `${BASE_URL}${redirectUrl}`,
        language: lang.name,
        langCode: lang.code,
        isDub: lang.isDub,
        isEmbed: true,
      });
    }
  });

  // Fallback
  if (sources.length === 0) {
    $("a[href*='/redirect/']").each((_, link) => {
      const redirectUrl = $(link).attr("href");
      const parent = $(link).closest("li, div");
      const langKey = parent.attr("data-lang-key");
      const hosterName =
        $(link).find("h4").text().trim() || $(link).text().trim().split("\n")[0].trim() || "Unknown";
      if (redirectUrl) {
        const lang = langKey ? langMap[langKey] : normalizeLang(parent.text());
        sources.push({
          name: hosterName,
          url: redirectUrl.startsWith("http") ? redirectUrl : `${BASE_URL}${redirectUrl}`,
          language: lang?.name || "Unknown",
          langCode: lang?.code || "und",
          isDub: lang?.isDub || false,
          isEmbed: true,
        });
      }
    });
  }

  const availableLanguages: string[] = [];
  $("img[alt*='Deutsch'], img[alt*='German'], img[alt*='English']").each((_, img) => {
    const alt = $(img).attr("alt") || "";
    if (alt && !availableLanguages.includes(alt)) availableLanguages.push(alt);
  });

  return {
    slug: fullSlug,
    episode: episodeNum,
    title,
    sources,
    availableLanguages: availableLanguages.length > 0 ? availableLanguages : undefined,
    headers: { Referer: watchUrl, "User-Agent": UA },
  };
}

export async function search(q: string) {
  Logger.info(`[Aniworld] Search: ${q}`);

  // Try AJAX search first
  try {
    const res = await fetch(`${BASE_URL}/ajax/search`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}/search`,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: `keyword=${encodeURIComponent(q)}`,
    });
    if (res.ok) {
      const text = await res.text();
      const fb = text.indexOf("[");
      const lb = text.lastIndexOf("]");
      if (fb !== -1 && lb !== -1) {
        const json = JSON.parse(text.substring(fb, lb + 1));
        const results = (Array.isArray(json) ? json : []).map((item: any) => ({
          title: item.title?.replace(/<[^>]*>?/gm, "") || "",
          slug: item.link?.split("/").pop() || "",
          url: item.link?.startsWith("http") ? item.link : `${BASE_URL}${item.link}`,
          description: item.description?.replace(/<[^>]*>?/gm, "") || "",
        }));
        return { results };
      }
    }
  } catch { }

  // HTML fallback
  const html = await fetchHtml(`${BASE_URL}/search?q=${encodeURIComponent(q)}`);
  const $ = cheerio.load(html);
  const results: any[] = [];
  $("a[href*='/stream/']").each((_, el) => {
    const title = $(el).find("h3").text().trim() || $(el).text().trim();
    const url = $(el).attr("href");
    if (url && title) {
      const slug = url.split("/stream/").pop()?.split("/")[0];
      if (slug) results.push({ title, slug, url: url.startsWith("http") ? url : `${BASE_URL}${url}` });
    }
  });

  return { results };
}
