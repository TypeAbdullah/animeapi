import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";
import { browserAjax, browserFetch } from "../animekai/lib/browserFetch.js";

const BASE_URL = "https://animelok.xyz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const ANILIST_SEARCH_CACHE_TTL = 6 * 60 * 60 * 1000;
const ANILIST_SLUG_CACHE_TTL = 6 * 60 * 60 * 1000;
const ANIMELOK_COMPAT_REFERER = `${BASE_URL}/watch/589da512247b`;
const ANIMELOK_COMPAT_COOKIE = "_ga=GA1.1.353903388.1775793817; _ga_21XGK270WM=GS2.1.s1775793816$o1$g1$t1775793819$j57$l0$h0";
let cookieCache = "";
let cookieCacheAt = 0;
const anilistSearchCache = new Map<string, { id: number | null; expiresAt: number }>();
const anilistSlugCache = new Map<number, { slug: string | null; expiresAt: number }>();

async function getSessionCookies(): Promise<string> {
  const now = Date.now();
  if (cookieCache && now - cookieCacheAt < 5 * 60 * 1000) return cookieCache;

  try {
    const res = await fetch(`${BASE_URL}/`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: BASE_URL,
        Origin: BASE_URL,
      },
      signal: AbortSignal.timeout(15000),
    });
    const setCookies = (res.headers as any).getSetCookie?.() || [];
    if (Array.isArray(setCookies) && setCookies.length > 0) {
      cookieCache = setCookies.map((c: string) => c.split(";")[0]).join("; ");
      cookieCacheAt = now;
    }
  } catch {
    // best-effort cookie fetch
  }

  return cookieCache;
}

async function fetchHtml(url: string, retries = 3): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: BASE_URL,
          Origin: BASE_URL,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // Direct fetch may return CF interstitial pages. Fall back to browser context.
      if (
        html.includes("Checking your connection") ||
        html.includes("challenge-platform") ||
        html.includes("__CF$cv$params")
      ) {
        try {
          return await browserFetch(url, `${BASE_URL}/home`);
        } catch {
          // keep original response if browser context fails
        }
      }

      return html;
    } catch (e) {
      lastErr = e as Error;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2 ** i * 500));
    }
  }
  throw lastErr!;
}

async function fetchApi(url: string): Promise<any> {
  const parseJsonLoose = (text: string): any => {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed); } catch { return null; }
    }
    const fb = trimmed.indexOf("{");
    const lb = trimmed.lastIndexOf("}");
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try { return JSON.parse(trimmed.substring(fb, lb + 1)); } catch { return null; }
    }
    return null;
  };

  const isBlockedPayload = (text: string): boolean => {
    const t = (text || "").toLowerCase();
    return (
      t.includes("unauthorized api access") ||
      t.includes("checking your connection") ||
      t.includes("challenge-platform") ||
      t.includes("__cf$cv$params")
    );
  };

  try {
    const cookieHeader = await getSessionCookies();
    const watchLike = url.match(/\/api\/anime\/([^/]+)\/episodes\/(\d+)/i);
    const watchCandidateId = String(watchLike?.[1] || "").trim();
    const requestReferer = watchLike
      ? (/^[a-f0-9]{8,}$/i.test(watchCandidateId) ? `${BASE_URL}/watch/${watchCandidateId}` : ANIMELOK_COMPAT_REFERER)
      : `${BASE_URL}/home`;
    const mergedCookie = [cookieHeader, ANIMELOK_COMPAT_COOKIE].filter(Boolean).join("; ");

    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en-US,en;q=0.6",
        Connection: "keep-alive",
        Host: "animelok.xyz",
        Referer: requestReferer,
        Origin: BASE_URL,
        "X-Requested-With": "XMLHttpRequest",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-GPC": "1",
        ...(mergedCookie ? { Cookie: mergedCookie } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      // Log for diagnostics
      Logger.warn(`[Animelok] API fetch failed: ${url} -> ${res.status}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!isBlockedPayload(text)) {
        const parsed = parseJsonLoose(text);
        if (parsed) return parsed;
    }

    throw new Error("Direct API blocked or non-JSON payload");
  } catch {
    // Browser-context fallback to reuse CF-cleared session for same-origin API
    try {
      await browserFetch(`${BASE_URL}/home`, BASE_URL);
      const watchLike = url.match(/\/api\/anime\/([^/]+)\/episodes\/(\d+)/i);
      const watchCandidateId = String(watchLike?.[1] || "").trim();
      const referer = watchLike
        ? (/^[a-f0-9]{8,}$/i.test(watchCandidateId) ? `${BASE_URL}/watch/${watchCandidateId}` : ANIMELOK_COMPAT_REFERER)
        : `${BASE_URL}/home`;
      const ajaxRes = await browserAjax(url, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.6",
          "X-Requested-With": "XMLHttpRequest",
          Referer: referer,
        },
      });

      if (typeof ajaxRes === "string") {
        return parseJsonLoose(ajaxRes);
      }
      return ajaxRes || null;
    } catch {
      return null;
    }
  }
}

function extractAnilistId(slug: string): number | null {
  const normalized = String(slug || "").trim();
  if (!normalized) return null;

  // Prefer explicit AniList markers when present.
  const explicitMatch = normalized.match(/(?:^|[^a-z0-9])anilist(?:[_-]?id)?[_-]?(\d{2,9})(?:$|[^0-9])/i);
  if (explicitMatch?.[1]) return toPositiveInt(explicitMatch[1]);

  // Legacy Animelok slug format embeds small AniList IDs at tail (e.g. one-piece-21, naruto-shippuden-1735).
  // Skip 5+ digit tails to avoid misclassifying HiAnime/internal IDs such as ...-20401.
  const legacyMatch = normalized.toLowerCase().match(/^[a-z0-9]+(?:-[a-z0-9]+)+-(\d{1,4})$/);
  if (!legacyMatch?.[1]) return null;
  return toPositiveInt(legacyMatch[1]);
}

function slugifyAnimelokTitle(value: string): string {
  return normalizeTitle(value)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return null;
}

function decodeLooseText(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const plusNormalized = raw.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusNormalized);
  } catch {
    return plusNormalized;
  }
}

function normalizeTitle(value?: string): string {
  return decodeLooseText(value).replace(/\s+/g, " ").trim();
}

function isLikelyBrokenTitle(title: string): boolean {
  const t = normalizeTitle(title);
  if (!t) return true;
  const hasReadableWord = /[a-z]{2,}/i.test(t);
  if (!hasReadableWord) return true;

  const letters = (t.match(/[a-z]/gi) || []).length;
  if (letters > 0 && letters / t.length < 0.35) return true;

  if (/^[\d.\-+\sA-Z]{6,}$/.test(t) && !/[a-z]/i.test(t)) return true;
  if (/\+/.test(t) && !/\s\+\s/.test(t)) return true;

  return false;
}

function extractAnilistIdFromHref(href?: string): number | null {
  if (!href) return null;
  try {
    const parsed = new URL(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    const queryValue =
      parsed.searchParams.get("anilist_id") ||
      parsed.searchParams.get("anilistId") ||
      parsed.searchParams.get("anilist");
    return toPositiveInt(queryValue);
  } catch {
    const match = href.match(/[?&](?:anilist_id|anilistId|anilist)=(\d+)/i);
    return match ? toPositiveInt(match[1]) : null;
  }
}

function extractAnilistIdFromPoster(poster?: string): number | null {
  const normalized = decodeLooseText(poster);
  if (!normalized) return null;

  const coverMatch = normalized.match(/\/bx(\d+)-/i);
  if (coverMatch?.[1]) return toPositiveInt(coverMatch[1]);

  const queryMatch = normalized.match(/[?&](?:anilist_id|anilistId|anilist)=(\d+)/i);
  if (queryMatch?.[1]) return toPositiveInt(queryMatch[1]);

  return null;
}

function scoreAnilistTitleCandidate(searchTitle: string, candidate: any): number {
  const needle = normalizeTitle(searchTitle).toLowerCase();
  const haystack = normalizeTitle(
    candidate?.title?.english ||
      candidate?.title?.romaji ||
      candidate?.title?.userPreferred ||
      candidate?.title?.native ||
      ""
  ).toLowerCase();

  if (!needle || !haystack) return 0;
  if (needle === haystack) return 100;

  let score = 0;
  const tokens = needle.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (haystack.includes(token)) score += 2;
  }
  if (haystack.includes(needle)) score += 5;
  if (needle.includes(haystack)) score += 3;
  return score;
}

async function resolveAnilistIdByTitle(title: string): Promise<number | null> {
  const normalizedTitle = normalizeTitle(title).toLowerCase();
  if (!normalizedTitle || normalizedTitle.length < 2 || isLikelyBrokenTitle(normalizedTitle)) {
    return null;
  }

  const cached = anilistSearchCache.get(normalizedTitle);
  if (cached && Date.now() <= cached.expiresAt) {
    return cached.id;
  }

  try {
    const response = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: `
          query ($search: String) {
            Page(page: 1, perPage: 5) {
              media(search: $search, type: ANIME) {
                id
                title {
                  romaji
                  english
                  native
                  userPreferred
                }
              }
            }
          }
        `,
        variables: { search: title },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      anilistSearchCache.set(normalizedTitle, {
        id: null,
        expiresAt: Date.now() + 60 * 1000,
      });
      return null;
    }

    const payload = (await response.json()) as any;
    const media = Array.isArray(payload?.data?.Page?.media) ? payload.data.Page.media : [];
    if (media.length === 0) {
      anilistSearchCache.set(normalizedTitle, {
        id: null,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return null;
    }

    const ranked = [...media].sort(
      (a, b) => scoreAnilistTitleCandidate(title, b) - scoreAnilistTitleCandidate(title, a)
    );
    const id = toPositiveInt(ranked[0]?.id);

    anilistSearchCache.set(normalizedTitle, {
      id,
      expiresAt: Date.now() + ANILIST_SEARCH_CACHE_TTL,
    });

    return id;
  } catch {
    anilistSearchCache.set(normalizedTitle, {
      id: null,
      expiresAt: Date.now() + 60 * 1000,
    });
    return null;
  }
}

async function resolveAnimelokSlugFromAniListId(anilistId: number): Promise<string | null> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return null;

  const cached = anilistSlugCache.get(anilistId);
  if (cached && Date.now() <= cached.expiresAt) {
    return cached.slug;
  }

  try {
    const response = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: `
          query ($id: Int) {
            Media(id: $id, type: ANIME) {
              title {
                english
                romaji
                userPreferred
                native
              }
            }
          }
        `,
        variables: { id: anilistId },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      anilistSlugCache.set(anilistId, {
        slug: null,
        expiresAt: Date.now() + 60 * 1000,
      });
      return null;
    }

    const payload = (await response.json()) as any;
    const media = payload?.data?.Media;
    const title =
      media?.title?.english ||
      media?.title?.romaji ||
      media?.title?.userPreferred ||
      media?.title?.native ||
      "";

    const slugBase = slugifyAnimelokTitle(String(title || ""));
    const slug = slugBase ? `${slugBase}-${anilistId}` : null;

    anilistSlugCache.set(anilistId, {
      slug,
      expiresAt: Date.now() + ANILIST_SLUG_CACHE_TTL,
    });

    return slug;
  } catch {
    anilistSlugCache.set(anilistId, {
      slug: null,
      expiresAt: Date.now() + 60 * 1000,
    });
    return null;
  }
}

function cleanAnimeId(id: string): string {
  const raw = String(id || "").trim();
  const withoutQuery = raw.split("?")[0] || raw;
  return withoutQuery
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^anime\//i, "")
    .replace(/^watch\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function extractAnimeSlugFromWatchHtml(html: string): string | null {
  if (!html) return null;

  const directMatch = html.match(/"animeSlug"\s*:\s*"([^"]+)"/i);
  if (directMatch?.[1]) return directMatch[1];

  const watchDataMatch = html.match(/"anime"\s*:\s*\{[^}]*"slug"\s*:\s*"([^"]+)"/i);
  if (watchDataMatch?.[1]) return watchDataMatch[1];

  const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']*\/watch\/([^?"']+)/i);
  if (ogUrlMatch?.[1] && /[a-z]/i.test(ogUrlMatch[1])) return ogUrlMatch[1];

  return null;
}

async function resolveAnimeSlug(id: string, ep = "1"): Promise<string> {
  const cleanedId = cleanAnimeId(id);
  if (!cleanedId) return "";

  // Slug-like IDs are already canonical for /api/anime/{slug}/...
  if (cleanedId.includes("-") && /[a-z]/i.test(cleanedId)) {
    return cleanedId;
  }

  // AniList-style numeric IDs should first try the canonical Animelok slug pattern:
  // {animename}-{anilistid}
  if (/^\d+$/.test(cleanedId)) {
    const numericAniListId = toPositiveInt(cleanedId);
    if (numericAniListId) {
      const anilistSlug = await resolveAnimelokSlugFromAniListId(numericAniListId);
      if (anilistSlug) {
        const probe = await fetchApi(`${BASE_URL}/api/anime/${encodeURIComponent(anilistSlug)}/episodes/${encodeURIComponent(ep)}`);
        if (probe?.episode) return anilistSlug;
      }
    }
  }

  // Watch IDs often look like hashes (e.g. /watch/392dac4a0699?ep=1).
  // Extract the canonical anime slug from the watch page payload.
  try {
    const watchHtml = await fetchHtml(`${BASE_URL}/watch/${cleanedId}?ep=${encodeURIComponent(ep)}`, 2);
    const slugFromWatch = extractAnimeSlugFromWatchHtml(watchHtml);
    if (slugFromWatch) return slugFromWatch;
  } catch {
    // Continue to search fallback.
  }

  const searchQueries = Array.from(new Set([
    cleanedId,
    cleanedId.replace(/-/g, " "),
  ].filter(Boolean)));

  for (const query of searchQueries) {
    try {
      const html = await fetchHtml(`${BASE_URL}/search?keyword=${encodeURIComponent(query)}`, 2);
      const $ = cheerio.load(html);
      const candidates = $("a[href^='/anime/']")
        .map((_, link) => {
          const href = $(link).attr("href") || "";
          return cleanAnimeId(href);
        })
        .get()
        .filter(Boolean);

      if (candidates.length === 0) continue;

      if (/^\d+$/.test(cleanedId)) {
        const exactByAniList = candidates.find((candidate) => candidate.endsWith(`-${cleanedId}`));
        if (exactByAniList) return exactByAniList;
      }

      return candidates[0];
    } catch {
      // Try next query candidate.
    }
  }

  return cleanedId;
}

function validateItem(item: any): boolean {
  return !!(item.id && item.title);
}

export async function getHome() {
  const html = await fetchHtml(`${BASE_URL}/home`);
  const $ = cheerio.load(html);
  const sections: any[] = [];

  $("section").each((_, section) => {
    const title =
      $(section).find("h2").first().text().trim() ||
      $(section).find("h3").first().text().trim();
    if (!title) return;

    const items: any[] = [];
    $(section).find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      const animeTitle =
        $(link).find("h3").first().text().trim() ||
        $(link).find(".font-bold").first().text().trim() ||
        $(link).find("[class*='title']").first().text().trim();
      const item = {
        id: slug,
        anilistId,
        title: animeTitle,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
      };
      if (validateItem(item)) items.push(item);
    });

    if (items.length > 0) sections.push({ title, items });
  });

  return { sections };
}

export async function search(q: string) {
  const html = await fetchHtml(`${BASE_URL}/search?keyword=${encodeURIComponent(q)}`);
  const $ = cheerio.load(html);
  const animes: any[] = [];

  $("a[href^='/anime/']").each((_, link) => {
    const url = $(link).attr("href");
    if (!url) return;
    const slug = url.split("/").pop() || "";
    const poster =
      $(link).find("img").attr("src") ||
      $(link).find("img").attr("data-src") ||
      $(link).find("img").attr("data-lazy-src");
    let anilistId =
      extractAnilistId(slug) ||
      toPositiveInt($(link).attr("data-anilist-id")) ||
      toPositiveInt($(link).attr("data-anilistid")) ||
      toPositiveInt($(link).attr("data-anilist")) ||
      extractAnilistIdFromHref(url) ||
      extractAnilistIdFromPoster(poster);
    const title = normalizeTitle(
      $(link).find("h3, h4").first().text().trim() ||
      $(link).find("[class*='title']").first().text().trim() ||
      $(link).find("img").attr("alt") ||
      $(link).attr("title") ||
      $(link).text().trim().split("\n")[0].trim()
    );
    if (title && slug && !isLikelyBrokenTitle(title)) {
      animes.push({
        id: slug,
        anilistId,
        title,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
      });
    }
  });

  const unique = Array.from(new Map(animes.map(a => [a.id, a])).values());

  const unresolved = unique
    .filter((anime: any) => !anime.anilistId && anime.title && !isLikelyBrokenTitle(anime.title))
    .slice(0, 8);

  await Promise.all(
    unresolved.map(async (anime: any) => {
      const resolved = await resolveAnilistIdByTitle(anime.title);
      if (resolved) anime.anilistId = resolved;
    })
  );

  return { animes: unique };
}

export async function getSchedule() {
  const html = await fetchHtml(`${BASE_URL}/schedule`);
  const $ = cheerio.load(html);
  const schedule: any[] = [];
  const dayNames = ["Yesterday", "Today", "Tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  $("section").each((_, section) => {
    const dayTitle = $(section).find("h2").first().text().trim();
    const dayMatch = dayNames.find(d => dayTitle.toLowerCase().includes(d.toLowerCase()));
    if (!dayMatch) return;

    const anime: any[] = [];
    $(section).find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const title =
        $(link).find("h3, h4, span").first().text().trim() ||
        $(link).text().trim().split("\n")[0].trim();
      const timeText = $(link).find("div, span").filter((_, el) => !!$(el).text().match(/\d{1,2}:\d{2}/)).first().text().match(/(\d{1,2}:\d{2})/)?.[1];
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      if (title && slug) {
        anime.push({
          id: anilistId?.toString() || slug,
          anilistId,
          title,
          time: timeText,
          poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        });
      }
    });

    if (anime.length > 0) {
      schedule.push({ day: dayMatch, anime: Array.from(new Map(anime.map(a => [a.id, a])).values()) });
    }
  });

  return { schedule };
}

export async function getRegionalSchedule() {
  const html = await fetchHtml(`${BASE_URL}/regional-schedule`);
  const $ = cheerio.load(html);
  const schedule: any[] = [];
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  $("h2, h3").each((_, heading) => {
    const dayTitle = $(heading).text().trim();
    const dayMatch = dayNames.find(d => dayTitle.toLowerCase() === d.toLowerCase() || dayTitle.toLowerCase().includes(d.toLowerCase() + " schedule"));
    if (!dayMatch) return;

    const container = $(heading).closest("section, div.mb-10, div.pb-12");
    const anime: any[] = [];
    container.find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const title =
        $(link).find("h3, h4, span").first().text().trim() ||
        $(link).text().trim().split("\n")[0].trim();
      const timeText = $(link).find("div, span").filter((_, el) => !!$(el).text().match(/\d{1,2}:\d{2}/)).first().text().match(/(\d{1,2}:\d{2})/)?.[1];
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      if (title && slug) {
        anime.push({
          id: anilistId?.toString() || slug,
          anilistId,
          title,
          time: timeText,
          poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        });
      }
    });

    if (anime.length > 0) {
      schedule.push({ day: dayMatch, anime: Array.from(new Map(anime.map(a => [a.id, a])).values()) });
    }
  });

  return { schedule };
}

export async function getLanguages(page = "1") {
  const html = await fetchHtml(`${BASE_URL}/languages?page=${page}`).catch(() => fetchHtml(`${BASE_URL}/home`));
  const $ = cheerio.load(html);
  const languages: any[] = [];

  $("a[href^='/languages/']").each((_, item) => {
    const link = $(item).attr("href");
    if (!link) return;
    const code = link.split("/").pop();
    if (!code || code === "languages") return;
    const name =
      $(item).find("span, h3, h2").first().text().trim() ||
      $(item).text().trim().split("\n")[0].trim();
    const poster =
      $(item).find("img").attr("src") ||
      $(item).find("img").attr("data-src") ||
      $(item).attr("style")?.match(/url\(['"]?([^'"]+)['"]?\)/)?.[1];
    if (name && code) {
      languages.push({
        name,
        code,
        url: link.startsWith("http") ? link : `${BASE_URL}${link}`,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
      });
    }
  });

  const unique = Array.from(new Map(languages.map(l => [l.code, l])).values());
  const hasNextPage =
    $("a, button")
      .filter((_, el) => {
        const t = $(el).text().toLowerCase();
        return (t.includes("next") || t === ">" || t === "»") && !$(el).hasClass("disabled") && !$(el).attr("disabled");
      })
      .length > 0;

  return { page: parseInt(page), languages: unique, hasNextPage };
}

export async function getLanguageAnime(language: string, page = "1") {
  const html = await fetchHtml(`${BASE_URL}/languages/${language}?page=${page}`);
  const $ = cheerio.load(html);
  const anime: any[] = [];

  $("a[href^='/anime/']").each((_, item) => {
    const url = $(item).attr("href");
    if (!url) return;
    const slug = url.split("/").pop() || "";
    const anilistId = extractAnilistId(slug);
    const title =
      $(item).find("h3, h4, .title").first().text().trim() ||
      $(item).text().trim().split("\n")[0].trim();
    const poster =
      $(item).find("img").attr("src") ||
      $(item).find("img").attr("data-src") ||
      $(item).find("img").attr("data-lazy-src");
    const rating = $(item).find("[class*='rating'], [class*='score']").text().trim();
    const year = $(item).find("span").filter((_, el) => !!$(el).text().match(/^\d{4}$/)).text().trim();
    if (title && slug && !["Home", "Movies", "TV Series"].includes(title)) {
      anime.push({
        id: anilistId?.toString() || slug,
        anilistId,
        title,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        rating: rating ? parseFloat(rating) : undefined,
        year: year || undefined,
      });
    }
  });

  const unique = Array.from(new Map(anime.filter(a => a.id && a.title).map(a => [a.id, a])).values());
  const hasNextPage =
    $("a, button")
      .filter((_, el) => {
        const t = $(el).text().toLowerCase();
        return (t.includes("next") || t === ">" || t === "»") && !$(el).hasClass("disabled") && !$(el).attr("disabled");
      })
      .length > 0;

  return { language, page: parseInt(page), anime: unique, hasNextPage };
}

export async function getAnimeInfo(id: string) {
  const resolvedId = await resolveAnimeSlug(id, "1");
  const html = await fetchHtml(`${BASE_URL}/anime/${resolvedId}`);
  const $ = cheerio.load(html);
  const anilistId = extractAnilistId(resolvedId);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.split(" - Animelok")[0]?.trim() ||
    "";
  const description =
    $("[class*='description']").first().text().trim() ||
    $("[class*='synopsis']").first().text().trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    "";
  const poster =
    $("img[class*='poster']").attr("src") ||
    $("img[class*='cover']").attr("src") ||
    $("meta[property='og:image']").attr("content") ||
    "";
  const ratingText =
    $("[class*='rating']").first().text().trim() || $("[class*='score']").first().text().trim();
  const rating = ratingText ? parseFloat(ratingText) : undefined;
  const genres: string[] = [];
  $("a[href*='/genres/'], [class*='genre'] a").each((_, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });

  // Seasons
  const seasons: any[] = [];
  const seasonsSection = $("h2, h3").filter((_, el) => $(el).text().toLowerCase().includes("season")).first();
  if (seasonsSection.length > 0) {
    seasonsSection.parent().find("a[href^='/anime/']").each((_, link) => {
      const seasonUrl = $(link).attr("href");
      const seasonSlug = seasonUrl?.split("/").pop();
      const seasonTitle = $(link).find("h3, h4").first().text().trim() || $(link).text().trim();
      const seasonPoster = $(link).find("img").attr("src") || $(link).find("img").attr("data-src");
      if (seasonSlug && seasonTitle) {
        seasons.push({
          id: seasonSlug,
          title: seasonTitle,
          poster: seasonPoster?.startsWith("http") ? seasonPoster : seasonPoster ? `${BASE_URL}${seasonPoster}` : undefined,
          url: seasonUrl?.startsWith("http") ? seasonUrl : seasonUrl ? `${BASE_URL}${seasonUrl}` : undefined,
        });
      }
    });
  }

  // Episodes
  let episodes: any[] = [];
  const languageHints = ["JAPANESE", "ENGLISH", "HINDI"];
  for (const lang of languageHints) {
    const apiData = await fetchApi(`${BASE_URL}/api/anime/${resolvedId}/episodes-range?page=0&lang=${lang}&pageSize=1000`);
    if (!apiData?.episodes || !Array.isArray(apiData.episodes) || apiData.episodes.length === 0) {
      continue;
    }

    episodes = apiData.episodes.map((ep: any) => ({
      number: ep.number,
      title: ep.name || `Episode ${ep.number}`,
      url: `${BASE_URL}/watch/${resolvedId}?ep=${ep.number}`,
      image: ep.img,
      isFiller: ep.isFiller,
    }));
    break;
  }

  if (episodes.length === 0 && $("a[href*='/watch/']").length > 0) {
    $("a[href*='/watch/']").each((_, link) => {
      const epUrl = $(link).attr("href");
      const epMatch = epUrl?.match(/ep[=\/](\d+)/i);
      const epNum = epMatch ? parseInt(epMatch[1], 10) : undefined;
      if (epNum) {
        const epTitle = $(link).text().trim() || `Episode ${epNum}`;
        episodes.push({
          number: epNum,
          title: epTitle,
          url: epUrl?.startsWith("http") ? epUrl : epUrl ? `${BASE_URL}${epUrl}` : undefined,
        });
      }
    });
  }

  return {
    id: resolvedId,
    anilistId,
    title,
    description,
    poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
    rating,
    genres: genres.length > 0 ? genres : undefined,
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes: episodes.sort((a, b) => a.number - b.number),
  };
}

export async function watch(id: string, ep: string, anilistIdHint?: number | string | null, malIdHint?: number | string | null) {
  const hintedAniListId = toPositiveInt(anilistIdHint);
  const hintedMalId = toPositiveInt(malIdHint);
  const hintedSlug = hintedAniListId ? await resolveAnimelokSlugFromAniListId(hintedAniListId) : null;
  const resolvedId = hintedSlug || await resolveAnimeSlug(id, ep);
  const cleanedId = cleanAnimeId(id);
  const baseWithoutNumericTail = cleanedId.replace(/-\d{1,9}$/i, "");
  const strippedBase = baseWithoutNumericTail
    .replace(/-season-\d+(?:-part-\d+)?$/i, "")
    .replace(/-part-\d+$/i, "");
  const hintedSlugCandidates = [];
  if (hintedAniListId) {
    hintedSlugCandidates.push(`${baseWithoutNumericTail}-${hintedAniListId}`);
    hintedSlugCandidates.push(`${strippedBase}-${hintedAniListId}`);
  }
  if (hintedMalId) {
    hintedSlugCandidates.push(`${baseWithoutNumericTail}-mal-${hintedMalId}`);
    hintedSlugCandidates.push(`${strippedBase}-mal-${hintedMalId}`);
  }

  const idCandidates = Array.from(new Set([hintedSlug, ...hintedSlugCandidates, resolvedId, cleanedId]).values())
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => {
        // Prioritize candidates that contain the hinted anilistId at the end
        if (hintedAniListId) {
            const aHasId = a.endsWith(`-${hintedAniListId}`);
            const bHasId = b.endsWith(`-${hintedAniListId}`);
            if (aHasId && !bHasId) return -1;
            if (!aHasId && bHasId) return 1;
        }
        return 0;
    });
  let apiData: any = null;
  let activeAnimeId = resolvedId || cleanedId;

  for (const candidateId of idCandidates) {
    const candidateUrl = `${BASE_URL}/api/anime/${candidateId}/episodes/${ep}`;
    Logger.info(`[Animelok] Trying candidate: ${candidateId} -> ${candidateUrl}`);
    try {
      const candidateData = await fetchApi(candidateUrl);
      if (candidateData?.episode) {
        Logger.info(`[Animelok] Success with candidate: ${candidateId}`);
        apiData = candidateData;
        activeAnimeId = candidateId;
        break;
      }
    } catch (e) {
      Logger.warn(`[Animelok] Candidate ${candidateId} failed: ${e}`);
    }
  }

  // Fallback: resolve real ID via search
  if (!apiData?.episode) {
    Logger.info(`[Animelok] API failed for ${id}, resolving via search`);
    try {
      const query = cleanedId.replace(/-\d{1,9}$/i, "").replace(/-/g, " ");
      const html = await fetchHtml(`${BASE_URL}/search?keyword=${encodeURIComponent(query)}`);
      const $ = cheerio.load(html);
      const candidateIds = $("a[href^='/anime/']")
        .map((_, link) => cleanAnimeId(String($(link).attr("href") || "").split("/").pop() || ""))
        .get()
        .filter(Boolean);

      const preferred = hintedAniListId
        ? candidateIds.find((candidate) => candidate.endsWith(`-${hintedAniListId}`))
        : undefined;
      const selectedId = preferred || candidateIds[0];

      if (selectedId) {
        const realId = cleanAnimeId(selectedId);
        if (realId && realId !== id) {
          Logger.info(`[Animelok] Resolved ${id} → ${realId}`);
          apiData = await fetchApi(`${BASE_URL}/api/anime/${realId}/episodes/${ep}`);
          if (apiData?.episode) activeAnimeId = realId;
        }
      }
    } catch (e) {
      Logger.warn(`[Animelok] ID resolution failed: ${e}`);
    }
  }

  if (!apiData?.episode) {
    return { id: activeAnimeId || id, episode: ep, servers: [], subtitles: [] };
  }

  const episodeData = apiData.episode;

  const parseServers = (raw: any): any[] => {
    if (typeof raw === "string") {
      try {
        const fb = raw.indexOf("[");
        const lb = raw.lastIndexOf("]");
        if (fb !== -1 && lb !== -1) raw = JSON.parse(raw.substring(fb, lb + 1));
        else return [];
      } catch { return []; }
    }
    if (!Array.isArray(raw)) return [];

    const resolveUrl = (entry: any): string => {
      let url =
        entry?.url ||
        entry?.directUrl ||
        entry?.src ||
        entry?.link ||
        entry?.file ||
        entry?.proxiedUrl ||
        "";

      if (typeof url === "string" && url.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(url);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const first = parsed[0] || {};
            url = first.url || first.file || first.src || first.link || url;
          }
        } catch {
          // Ignore JSON parsing failures and keep raw url value.
        }
      }

      return typeof url === "string" ? url.trim() : "";
    };

    const normalized = raw
      .flatMap((server: any) => {
        const entries = Array.isArray(server?.sources) && server.sources.length > 0
          ? server.sources.map((source: any) => ({ ...server, ...source }))
          : [server];

        return entries.map((entry: any) => {
          let language = entry.languages?.[0] || entry.language || "";
          const lc = String(entry.langCode || "");
          if (lc.includes("TAM")) language = "Tamil";
          else if (lc.includes("MAL")) language = "Malayalam";
          else if (lc.includes("TEL")) language = "Telugu";
          else if (lc.includes("KAN")) language = "Kannada";
          else if (lc.includes("HIN") || entry.name?.toLowerCase().includes("cloud") || entry.tip?.toLowerCase().includes("cloud")) language = "Hindi";
          else if (lc.includes("ENG") || lc.includes("EN")) language = "English";
          else if (lc.includes("JAP")) language = "Japanese";
          if (!language.trim()) language = "Other";
          if (["eng", "english"].includes(language.toLowerCase())) language = "English";
          language = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();

          const url = resolveUrl(entry);
          const isM3U8 =
            Boolean(entry.isM3U8 || entry.type === "hls") ||
            (typeof url === "string" && url.toLowerCase().includes(".m3u8"));

          return { name: entry.name, url, language, tip: entry.tip, isM3U8 };
        });
      })
      .filter((server: any) => Boolean(server?.url));

    const seen = new Set<string>();
    return normalized.filter((server: any) => {
      if (seen.has(server.url)) return false;
      seen.add(server.url);
      return true;
    });
  };

  let servers = parseServers(episodeData.servers);

  if (servers.length === 0) {
    const [dubData, subData] = await Promise.all([
      fetchApi(`${BASE_URL}/api/anime/${activeAnimeId}/episodes/${ep}?lang=dub`),
      fetchApi(`${BASE_URL}/api/anime/${activeAnimeId}/episodes/${ep}?lang=sub`),
    ]);
    const dubServers = parseServers(dubData?.episode?.servers).map(s => ({ ...s, language: s.language === "Other" ? "Dub" : s.language }));
    const subServers = parseServers(subData?.episode?.servers).map(s => ({ ...s, language: s.language === "Other" ? "Sub" : s.language }));
    const seen = new Set();
    for (const s of [...dubServers, ...subServers]) {
      if (!seen.has(s.url)) { servers.push(s); seen.add(s.url); }
    }
  }

  const rawSubs = episodeData.subtitles || [];
  const seenSubs = new Set<string>();
  const subtitles = (Array.isArray(rawSubs) ? rawSubs : []).map((sub: any) => ({
    label: sub.name || sub.label || "English",
    src: sub.url || sub.src,
  })).filter((sub: any) => {
    if (!sub.src || seenSubs.has(sub.src)) return false;
    seenSubs.add(sub.src);
    return true;
  });

  // Episode list for navigation
  let episodes: any[] = [];
  try {
    const allEps = await fetchApi(`${BASE_URL}/api/anime/${activeAnimeId}/episodes-range?page=0&lang=JAPANESE&pageSize=1000`);
    if (allEps?.episodes) {
      episodes = allEps.episodes.map((e: any) => ({
        number: e.number,
        title: e.name || `Episode ${e.number}`,
        url: `${BASE_URL}/watch/${activeAnimeId}?ep=${e.number}`,
        isFiller: e.isFiller,
      }));
    }
  } catch { }

  return {
    id: activeAnimeId,
    anilistId: toPositiveInt(apiData.anime?.anilistId) || hintedAniListId || extractAnilistId(activeAnimeId),
    animeTitle: apiData.anime?.title || "Unknown Anime",
    episode: ep,
    title: episodeData.name || `Episode ${ep}`,
    servers,
    subtitles,
    episodes: episodes.length > 0 ? episodes : undefined,
  };
}
