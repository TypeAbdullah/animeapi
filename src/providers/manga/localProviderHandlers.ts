import { allmanga } from "./scrapers/allmanga.js";
import { atsu } from "./scrapers/atsu.js";
import { mangaball } from "./scrapers/mangaball.js";
import { mangafire } from "./scrapers/mangafire.js";
import { AniList } from "../mapper/anilist.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

const DEFAULT_ATSU_TYPES = "Manga,Manwha,Manhua,OEL";
const anilist = new AniList();
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const MANGA_HOME_FALLBACK_DIR = nodePath.join(process.cwd(), "fallback", "manga-home");

type HomeFallbackSnapshot = {
  provider: string;
  savedAt: string;
  data: unknown;
};

const isLocalhostRequest = (requestUrl: string) => {
  try {
    const parsed = new URL(requestUrl);
    return LOCALHOST_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
};

const getHomeFallbackFilePath = (provider: string) => {
  const safeProvider = String(provider || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return nodePath.join(MANGA_HOME_FALLBACK_DIR, `${safeProvider || "provider"}.json`);
};

const saveHomeFallbackSnapshot = async (requestUrl: string, provider: string, data: unknown) => {
  if (!isLocalhostRequest(requestUrl)) return;

  try {
    await mkdir(MANGA_HOME_FALLBACK_DIR, { recursive: true });
    const payload: HomeFallbackSnapshot = {
      provider,
      savedAt: new Date().toISOString(),
      data,
    };
    await writeFile(getHomeFallbackFilePath(provider), JSON.stringify(payload), "utf-8");
  } catch {
    // Snapshot persistence should not break the request path.
  }
};

const loadHomeFallbackSnapshot = async (requestUrl: string, provider: string) => {
  if (!isLocalhostRequest(requestUrl)) return null;

  try {
    const raw = await readFile(getHomeFallbackFilePath(provider), "utf-8");
    const parsed = JSON.parse(raw) as Partial<HomeFallbackSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!("data" in parsed)) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const resolveHomeWithLocalhostFallback = async (
  c: any,
  provider: string,
  fetchHome: () => Promise<unknown>
) => {
  const data = await fetchHome();
  const error = scraperError(data);

  if (!error) {
    await saveHomeFallbackSnapshot(c.req.url, provider, data);
    return ok(c, data);
  }

  const fallbackData = await loadHomeFallbackSnapshot(c.req.url, provider);
  if (fallbackData) {
    return c.json({
      status: 200,
      success: true,
      data: fallbackData,
      fallback: true,
      fallbackProvider: provider,
      fallbackReason: error,
      fallbackSource: "localhost-home-snapshot",
    });
  }

  return fail(c, 500, error);
};

const toPositiveInt = (raw: string | null, fallback: number) => {
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const scraperError = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  if (!("error" in (value as Record<string, unknown>))) return null;
  const errorValue = (value as Record<string, unknown>).error;
  if (!errorValue) return "Unknown provider error";
  return String(errorValue);
};

const normalizeTitle = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const titleMatchScore = (left: string, right: string) => {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aWords = a.split(" ").filter(Boolean);
  const bWords = new Set(b.split(" ").filter(Boolean));
  const common = aWords.filter((word) => bWords.has(word)).length;
  const overlap = common / Math.max(aWords.length, bWords.size || 1);

  if (a.includes(b) || b.includes(a)) {
    return Math.max(overlap, 0.9);
  }

  return overlap;
};

const resolveMangafireIdFromAnilistId = async (anilistId: number) => {
  const media = await anilist.getMangaInfo(anilistId);
  if (!media) return null;

  const candidateTitles = [
    media.title?.english,
    media.title?.romaji,
    media.title?.userPreferred,
    media.title?.native,
    ...(Array.isArray(media.synonyms) ? media.synonyms : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const uniqueTitles = [...new Set(candidateTitles)];
  let bestMatch: { id: string; score: number } | null = null;

  for (const title of uniqueTitles) {
    const result = await mangafire.search(title, 1);
    const rows = Array.isArray(result?.results) ? result.results : [];

    for (const row of rows) {
      const rowId = String(row?.id || "").trim();
      const rowTitle = String(row?.title || "").trim();
      if (!rowId || !rowTitle) continue;

      const score = titleMatchScore(title, rowTitle);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: rowId, score };
      }
    }

    if (bestMatch && bestMatch.score >= 0.97) {
      break;
    }
  }

  if (!bestMatch || bestMatch.score < 0.35) {
    return null;
  }

  return bestMatch.id;
};

const ok = (c: any, data: unknown) =>
  c.json({
    status: 200,
    success: true,
    data,
  });

const fail = (c: any, status: number, message: string) =>
  c.json(
    {
      status,
      success: false,
      message,
      data: null,
    },
    status as 400 | 404 | 500 | 502
  );

const binary = (body: Buffer | ArrayBuffer, contentType: string, cacheControl = "public, max-age=86400") => {
  const headers = new Headers();
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set("cache-control", cacheControl);

  const responseBody = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body);

  return new Response(responseBody, {
    status: 200,
    headers,
  });
};

const getProviderBaseApiUrl = (requestUrl: string, provider: string) => {
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}/api/v2/manga/${provider}`;
};

const getProviderPathSegments = (requestUrl: string, provider: string, isAdultAlias: boolean) => {
  const parsed = new URL(requestUrl);
  const marker = isAdultAlias
    ? `/manga/adult/${provider}`
    : `/manga/${provider}`;

  const index = parsed.pathname.indexOf(marker);
  if (index < 0) {
    return {
      segments: [] as string[],
      searchParams: parsed.searchParams,
      rawTail: "",
    };
  }

  const tail = parsed.pathname.slice(index + marker.length);
  const normalizedTail = tail === "/" ? "" : tail;
  const segments = normalizedTail
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  return {
    segments,
    searchParams: parsed.searchParams,
    rawTail: normalizedTail,
  };
};

const handleMangaball = async (c: any, segments: string[], searchParams: URLSearchParams) => {
  const baseApiUrl = getProviderBaseApiUrl(c.req.url, "mangaball");

  if (segments.length === 0) {
    return ok(c, {
      provider: "Mangaball",
      status: "operational",
      message: "Mangaball scraper is running in TatakaiCore",
    });
  }

  const head = segments[0];
  const tail = segments.slice(1);

  if (head === "recommendation") {
    const data = await mangaball.parseRecommendation(baseApiUrl, toPositiveInt(searchParams.get("limit"), 12));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "home") {
    return resolveHomeWithLocalhostFallback(c, "mangaball", () => mangaball.parseHome(baseApiUrl));
  }

  if (head === "latest") {
    const data = await mangaball.parseLatest(
      baseApiUrl,
      toPositiveInt(searchParams.get("page"), 1),
      toPositiveInt(searchParams.get("limit"), 24)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "foryou") {
    const data = await mangaball.parseForYou(
      String(searchParams.get("time") || "day"),
      baseApiUrl,
      toPositiveInt(searchParams.get("limit"), 12)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "recent") {
    const data = await mangaball.parseRecent(
      String(searchParams.get("time") || "day"),
      baseApiUrl,
      toPositiveInt(searchParams.get("limit"), 12)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "popular") {
    const data = await mangaball.parsePopular(baseApiUrl, toPositiveInt(searchParams.get("limit"), 24));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "origin") {
    const data = await mangaball.parseOrigin(String(searchParams.get("origin") || "all"), baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "added") {
    const data = await mangaball.parseAdded(
      toPositiveInt(searchParams.get("page"), 1),
      baseApiUrl,
      toPositiveInt(searchParams.get("limit"), 24)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "new-chap") {
    const data = await mangaball.parseNewChap(
      toPositiveInt(searchParams.get("page"), 1),
      baseApiUrl,
      toPositiveInt(searchParams.get("limit"), 24)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  const advancedLangMap: Record<string, string> = {
    manga: "jp",
    manhwa: "kr",
    manhua: "zh",
    comics: "en",
  };

  if (head in advancedLangMap) {
    const data = await mangaball.parseAdvanced({
      baseApiUrl,
      page: toPositiveInt(searchParams.get("page"), 1),
      limit: toPositiveInt(searchParams.get("limit"), 24),
      originalLang: advancedLangMap[head],
    });
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  const publicationStatusMap: Record<string, string> = {
    ongoing: "ongoing",
    completed: "completed",
    "on-hold": "on_hold",
    cancelled: "cancelled",
    hiatus: "hiatus",
  };

  if (head in publicationStatusMap) {
    const data = await mangaball.parseAdvanced({
      baseApiUrl,
      page: toPositiveInt(searchParams.get("page"), 1),
      limit: toPositiveInt(searchParams.get("limit"), 24),
      publicationStatus: publicationStatusMap[head],
    });
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "search") {
    const q = String(searchParams.get("q") || "").trim();
    if (!q) return fail(c, 400, "Query parameter 'q' is required");

    const data = await mangaball.parseSearch(
      q,
      toPositiveInt(searchParams.get("page"), 1),
      baseApiUrl,
      toPositiveInt(searchParams.get("limit"), 24)
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "filters") {
    const data = await mangaball.parseFilters({
      baseApiUrl,
      q: String(searchParams.get("q") || ""),
      sort: String(searchParams.get("sort") || "updated_chapters_desc"),
      page: toPositiveInt(searchParams.get("page"), 1),
      limit: toPositiveInt(searchParams.get("limit"), 10),
      tagIncluded: searchParams.getAll("tag_included"),
      tagIncludedMode: String(searchParams.get("tag_included_mode") || "and"),
      tagExcluded: searchParams.getAll("tag_excluded"),
      tagExcludedMode: String(searchParams.get("tag_excluded_mode") || "and"),
      demographic: String(searchParams.get("demographic") || "any"),
      person: String(searchParams.get("person") || "any"),
      originalLang: String(searchParams.get("original_lang") || "any"),
      publicationStatus: String(searchParams.get("status") || "any"),
      translatedLang: searchParams.getAll("translated_lang"),
    });
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "person-search") {
    const q = String(searchParams.get("q") || "").trim();
    if (!q) return fail(c, 400, "Query parameter 'q' is required");

    const data = await mangaball.parsePersonSearch(q);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "person") {
    if (!tail[0]) return fail(c, 400, "Missing person ID");
    const data = await mangaball.parsePerson(tail[0], toPositiveInt(searchParams.get("page"), 1), baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "tags") {
    if (!tail[0]) {
      const data = await mangaball.parseTags();
      const error = scraperError(data);
      return error ? fail(c, 500, error) : ok(c, data);
    }

    if (tail[0] === "detail") {
      const data = await mangaball.parseTagsDetail();
      const error = scraperError(data);
      return error ? fail(c, 500, error) : ok(c, data);
    }

    const data = await mangaball.parseTagsById(tail[0], toPositiveInt(searchParams.get("page"), 1), baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "keyword") {
    if (!tail[0]) return fail(c, 400, "Missing keyword ID");
    const data = await mangaball.parseKeyword(tail[0], toPositiveInt(searchParams.get("page"), 1), baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "detail") {
    if (!tail[0]) return fail(c, 400, "Missing slug");
    const data = await mangaball.parseDetail(tail[0], baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 404, error) : ok(c, data);
  }

  if (head === "read") {
    if (!tail[0]) return fail(c, 400, "Missing chapter ID");
    const data = await mangaball.parseRead(tail[0], baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 404, error) : ok(c, data);
  }

  if (head === "image") {
    const path = tail.join("/");
    if (!path) return fail(c, 400, "Missing image path");

    const result = await mangaball.proxyImage(path);
    if (!result) return fail(c, 404, "Image not found");
    return binary(result.content, result.contentType);
  }

  return fail(c, 404, `Unsupported Mangaball endpoint: /${segments.join("/")}`);
};

const handleAllmanga = async (c: any, segments: string[], searchParams: URLSearchParams, rawTail: string) => {
  const baseApiUrl = getProviderBaseApiUrl(c.req.url, "allmanga");

  if (segments.length === 0) {
    return ok(c, {
      provider: "AllManga",
      status: "operational",
      message: "AllManga scraper is running in TatakaiCore",
    });
  }

  const head = segments[0];
  const tail = segments.slice(1);

  if (head === "home") {
    return resolveHomeWithLocalhostFallback(c, "allmanga", () => allmanga.parseHome(baseApiUrl));
  }

  if (head === "search") {
    const q = String(searchParams.get("q") || "").trim();
    if (!q) return fail(c, 400, "Query parameter 'q' is required");

    const data = await allmanga.parseSearch(q, baseApiUrl, toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "latest") {
    const data = await allmanga.parseSearch("", baseApiUrl, toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "popular") {
    const data = await allmanga.parsePopular(
      baseApiUrl,
      toPositiveInt(searchParams.get("page"), 1),
      toPositiveInt(searchParams.get("size"), 20),
      String(searchParams.get("period") || "daily")
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "random") {
    const data = await allmanga.parseRandom(baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "tags") {
    const data = await allmanga.parseTags();
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "genre") {
    if (!tail[0]) return fail(c, 400, "Missing genre slug");
    const data = await allmanga.parseSearch("", baseApiUrl, toPositiveInt(searchParams.get("page"), 1), {
      genres: [tail[0]],
    });
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "author") {
    if (!tail[0]) return fail(c, 400, "Missing author slug");
    const data = await allmanga.parseSearch("", baseApiUrl, toPositiveInt(searchParams.get("page"), 1), {
      authors: [tail[0]],
    });
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "detail") {
    const id = String(searchParams.get("id") || "").trim();
    if (!id) return fail(c, 400, "Query parameter 'id' is required");

    const data = await allmanga.parseDetail(id, baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "read") {
    const id = String(searchParams.get("id") || "").trim();
    if (!id) return fail(c, 400, "Query parameter 'id' is required");

    const data = await allmanga.parseRead(id, baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "image") {
    const imagePath = `${rawTail.split("/image/")[1] || ""}${new URL(c.req.url).search}`;
    if (!imagePath) return fail(c, 400, "Missing image path");

    const targetUrl = imagePath.startsWith("http") ? imagePath : `https://${imagePath}`;
    const result = await allmanga.proxyImage(targetUrl);

    if (!result?.success) {
      return fail(c, Number(result?.status || 500), `Proxy failed: ${String(result?.error || "unknown")}`);
    }

    return binary(result.content, String(result.contentType || "image/jpeg"));
  }

  return fail(c, 404, `Unsupported AllManga endpoint: /${segments.join("/")}`);
};

const handleAtsu = async (
  c: any,
  provider: string,
  isAdultAlias: boolean,
  segments: string[],
  searchParams: URLSearchParams
) => {
  if (provider !== "atsu") return null;

  const baseApiUrl = getProviderBaseApiUrl(c.req.url, "atsu");
  let adultMode = isAdultAlias;
  let actionSegments = segments;

  if (!adultMode && actionSegments[0] === "adult") {
    adultMode = true;
    actionSegments = actionSegments.slice(1);
  }

  if (actionSegments.length === 0) {
    return ok(c, {
      provider: "Atsu",
      status: "operational",
      mode: adultMode ? "adult" : "standard",
      message: "Atsu scraper is running in TatakaiCore",
    });
  }

  const head = actionSegments[0];
  const tail = actionSegments.slice(1);

  if (head === "image") {
    const path = tail.join("/");
    if (!path) return fail(c, 400, "Missing image path");
    const result = await atsu.proxyImage(path);
    if (!result) return fail(c, 404, "Image not found");
    return binary(result.content, result.contentType);
  }

  if (head === "home") {
    return resolveHomeWithLocalhostFallback(c, "atsu", () => atsu.parseHome(baseApiUrl, adultMode));
  }

  const sectionMap: Record<string, string> = {
    trending: "trending",
    "most-bookmarked": "mostBookmarked",
    "hot-updates": "recentlyUpdated",
    "top-rated": "topRated",
    popular: "popular",
    "recently-added": "recentlyAdded",
  };

  if (head in sectionMap) {
    const queryParams: Record<string, string> = {
      types: String(searchParams.get("types") || DEFAULT_ATSU_TYPES),
    };
    if (head === "most-bookmarked") {
      queryParams.timeframe = String(searchParams.get("timeframe") || "7");
    }

    const data = await atsu.fetchInfiniteSection(
      sectionMap[head],
      toPositiveInt(searchParams.get("page"), 0),
      queryParams,
      baseApiUrl,
      adultMode
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (!adultMode && head === "detail") {
    if (!tail[0]) return fail(c, 400, "Missing manga ID");
    const data = await atsu.fetchMangaDetails(tail[0], baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (!adultMode && head === "info") {
    if (!tail[0]) return fail(c, 400, "Missing manga ID");
    const data = await atsu.fetchChapterInfo(tail[0]);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (!adultMode && head === "read") {
    const mangaId = String(searchParams.get("mangaId") || "").trim();
    const chapterId = String(searchParams.get("chapterId") || "").trim();
    if (!mangaId || !chapterId) {
      return fail(c, 400, "mangaId and chapterId query parameters are required");
    }

    const data = await atsu.fetchChapterPages(mangaId, chapterId, baseApiUrl);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (!adultMode && head === "filters") {
    const data = await atsu.fetchFilters();
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "explore") {
    const data = await atsu.fetchFilteredView(
      {
        genres: String(searchParams.get("genres") || "") || undefined,
        types: String(searchParams.get("types") || "") || undefined,
        statuses: String(searchParams.get("statuses") || "") || undefined,
        page: toPositiveInt(searchParams.get("page"), 0),
        adult: adultMode,
      },
      baseApiUrl
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "genre") {
    if (!tail[0]) return fail(c, 400, "Missing genre slug");
    const data = await atsu.fetchFilteredView(
      {
        genres: tail[0],
        page: toPositiveInt(searchParams.get("page"), 0),
        adult: adultMode,
      },
      baseApiUrl
    );
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "author") {
    if (!tail[0]) return fail(c, 400, "Missing author slug");
    const data = await atsu.fetchAuthor(
      tail[0],
      toPositiveInt(searchParams.get("page"), 0),
      String(searchParams.get("type") || "") || undefined,
      baseApiUrl
    );
    const error = scraperError(data);
    if (error) return fail(c, 500, error);

    if (!adultMode && data?.items && Array.isArray(data.items)) {
      data.items = data.items.filter((item: any) => !item?.isAdult);
    }

    return ok(c, data);
  }

  return fail(c, 404, `Unsupported Atsu endpoint: /${actionSegments.join("/")}`);
};

const handleMangafire = async (c: any, segments: string[], searchParams: URLSearchParams) => {
  const baseInfo = {
    provider: "MangaFire",
    status: "operational",
    message: "MangaFire scraper is running in TatakaiCore",
  };

  if (segments.length === 0) {
    return ok(c, baseInfo);
  }

  const head = segments[0];
  const tail = segments.slice(1);

  if (head === "home") {
    return resolveHomeWithLocalhostFallback(c, "mangafire", () => mangafire.scrapeHomePage());
  }

  if (head === "search") {
    const q = String(searchParams.get("q") || "").trim();
    if (!q) return fail(c, 400, "Query 'q' is required for search");

    const data = await mangafire.search(q, toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "latest") {
    const data = await mangafire.scrapeLatestPage("updated", toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "category") {
    if (!tail[0]) return fail(c, 400, "Missing category");
    const data = await mangafire.scrapeCategory(tail[0], toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "genre") {
    if (!tail[0]) return fail(c, 400, "Missing genre");
    const data = await mangafire.scrapeGenre(tail[0], toPositiveInt(searchParams.get("page"), 1));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "detail") {
    if (!tail[0]) return fail(c, 400, "Missing manga ID");
    const data = await mangafire.scrapeMangaInfo(tail[0]);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "chapters") {
    if (!tail[0]) return fail(c, 400, "Missing manga ID");

    let mangaId = tail[0];
    if (/^\d+$/.test(mangaId)) {
      const resolvedId = await resolveMangafireIdFromAnilistId(Number.parseInt(mangaId, 10));
      if (!resolvedId) {
        return fail(c, 404, `Unable to map AniList ID ${mangaId} to MangaFire`);
      }
      mangaId = resolvedId;
    }

    const lang = String(searchParams.get("lang") || searchParams.get("language") || "");
    const data = await mangafire.getChapters(mangaId, lang);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "read") {
    if (!tail[0]) return fail(c, 400, "Missing chapter ID");
    const data = await mangafire.getChapterImages(tail[0]);
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  if (head === "volumes") {
    if (!tail[0]) return fail(c, 400, "Missing manga ID");
    const data = await mangafire.getVolumes(tail[0], String(searchParams.get("lang") || "en"));
    const error = scraperError(data);
    return error ? fail(c, 500, error) : ok(c, data);
  }

  return fail(c, 404, `Unsupported MangaFire endpoint: /${segments.join("/")}`);
};

export const handleLocalMangaProviderRequest = async (c: any, provider: string, isAdultAlias: boolean) => {
  const method = String(c.req.method || "GET").toUpperCase();
  if (method !== "GET") {
    return null;
  }

  const { segments, searchParams, rawTail } = getProviderPathSegments(c.req.url, provider, isAdultAlias);

  if (provider === "mangaball") {
    return handleMangaball(c, segments, searchParams);
  }

  if (provider === "allmanga") {
    return handleAllmanga(c, segments, searchParams, rawTail);
  }

  if (provider === "atsu") {
    return handleAtsu(c, provider, isAdultAlias, segments, searchParams);
  }

  if (provider === "mangafire") {
    return handleMangafire(c, segments, searchParams);
  }

  return null;
};
