import { Hono } from "hono";
import { AniList, type AnilistAnimeInfo } from "../providers/mapper/anilist.js";
import { searchManga } from "../providers/manga/service.js";
import type {
  UnifiedAnimeSearchResult,
  UnifiedContentStatus,
  UnifiedMangaSearchResult,
  UnifiedSearchResult,
} from "../providers/manga/contracts.js";

export const mediaRouter = new Hono();
const anilist = new AniList();

const toStatus = (status?: string): UnifiedContentStatus => {
  const value = String(status || "").trim().toLowerCase();
  if (["releasing", "publishing", "ongoing"].includes(value)) return "ongoing";
  if (["finished", "completed"].includes(value)) return "completed";
  if (value === "hiatus") return "hiatus";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  if (["not_yet_released", "unreleased"].includes(value)) return "unreleased";
  return "unknown";
};

const parseNumberish = (value: unknown): number | null => {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const computeConfidence = (query: string, title: string): number => {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTitle = title.trim().toLowerCase();

  if (!normalizedQuery || !normalizedTitle) return 0.6;
  if (normalizedQuery === normalizedTitle) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 0.9;

  return 0.75;
};

const mapAnimeSearch = (query: string, item: AnilistAnimeInfo): UnifiedAnimeSearchResult => {
  const canonicalTitle =
    item.title?.english || item.title?.romaji || item.title?.native || item.title?.userPreferred || "Untitled";

  return {
    mediaType: "anime",
    anilistId: item.id,
    malId: item.idMal || undefined,
    canonicalTitle,
    title: {
      romaji: item.title?.romaji,
      english: item.title?.english,
      native: item.title?.native,
    },
    poster: item.coverImage?.large || item.coverImage?.medium || null,
    status: toStatus(item.status),
    year: item.startDate?.year || null,
    score: parseNumberish(item.averageScore),
    popularity: parseNumberish(item.popularity),
    providersAvailable: ["hianime"],
    matchConfidence: computeConfidence(query, canonicalTitle),
    episodes: parseNumberish(item.episodes),
    duration: parseNumberish(item.duration),
    audioLanguages: [],
    subtitleLanguages: [],
  };
};

const bySearchRank = (left: UnifiedSearchResult, right: UnifiedSearchResult) => {
  if (left.matchConfidence !== right.matchConfidence) {
    return right.matchConfidence - left.matchConfidence;
  }

  const leftScore = left.score || 0;
  const rightScore = right.score || 0;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  const leftPopularity = left.popularity || 0;
  const rightPopularity = right.popularity || 0;
  if (leftPopularity !== rightPopularity) {
    return rightPopularity - leftPopularity;
  }

  return `${left.mediaType}:${left.anilistId}`.localeCompare(`${right.mediaType}:${right.anilistId}`);
};

const dedupeResults = (results: UnifiedSearchResult[]): UnifiedSearchResult[] => {
  const dedupeMap = new Map<string, UnifiedSearchResult>();

  for (const result of results) {
    const key = `${result.mediaType}:${result.anilistId}`;
    const existing = dedupeMap.get(key);
    if (!existing || result.matchConfidence > existing.matchConfidence) {
      dedupeMap.set(key, result);
    }
  }

  return [...dedupeMap.values()];
};

mediaRouter.get("/search", async (c) => {
  const query = String(c.req.query("q") || "").trim();
  if (!query) {
    return c.json({ status: 400, message: "Missing required query parameter: q" }, 400);
  }

  const mode = String(c.req.query("mode") || "blended").trim().toLowerCase() === "segmented" ? "segmented" : "blended";
  const page = Number.parseInt(String(c.req.query("page") || "1"), 10) || 1;
  const limit = Number.parseInt(String(c.req.query("limit") || "24"), 10) || 24;

  const [anime, manga] = await Promise.all([
    anilist.searchAnime(query, page, Math.min(limit, 50)),
    searchManga(query, page, Math.min(limit, 50)),
  ]);

  const animeResults = anime.map((item) => mapAnimeSearch(query, item));
  const mangaResults = manga.results;

  if (mode === "segmented") {
    return c.json({
      success: true,
      mode,
      query,
      page,
      limit,
      partial: manga.partial,
      failedProviders: manga.failedProviders,
      anime: {
        total: animeResults.length,
        results: animeResults,
      },
      manga: {
        total: mangaResults.length,
        results: mangaResults,
      },
    });
  }

  const blended = dedupeResults([
    ...(animeResults as UnifiedSearchResult[]),
    ...(mangaResults as UnifiedMangaSearchResult[]),
  ]).sort(bySearchRank);

  return c.json({
    success: true,
    mode,
    query,
    page,
    limit,
    partial: manga.partial,
    failedProviders: manga.failedProviders,
    total: blended.length,
    results: blended,
  });
});
