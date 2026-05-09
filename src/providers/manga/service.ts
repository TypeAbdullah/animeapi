import { Cache } from "../../lib/cache.js";
import { log, logRateLimited } from "../../config/logger.js";
import { canonicalStore } from "../../lib/canonicalStore.js";
import { AniList, type AnilistMangaInfo } from "../mapper/anilist.js";
import type {
  FacetCountGroup,
  FacetCounts,
  UnifiedChapter,
  UnifiedContentStatus,
  UnifiedFilterSchema,
  UnifiedMangaDetail,
  UnifiedMangaSearchResult,
  UnifiedMangaTitle,
  UnifiedReadPage,
  UnifiedReadResponse,
} from "./contracts.js";
import {
  MANGA_MAPPER_PROVIDERS,
  fetchAllMapperChapters,
  fetchMapperPages,
  isSupportedMangaMapperProvider,
  type MapperChapter,
} from "./mapperBridge.js";
import { resolveMangaId, type ResolvedMangaId } from "./id.js";

const SEARCH_TTL_SECONDS = 120;
const DETAIL_TTL_SECONDS = 1800;
const CHAPTER_TTL_SECONDS = 900;
const READ_TTL_SECONDS = 600;
const CHAPTER_CANONICAL_FRESH_MS = 12 * 60 * 60 * 1000;
const READ_CANONICAL_FRESH_MS = 12 * 60 * 60 * 1000;
const CANONICAL_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

type MangaCacheControlOptions = {
  forceFresh?: boolean;
};

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

const canonicalTitle = (media: Pick<AnilistMangaInfo, "title">): string => {
  return (
    media.title?.english ||
    media.title?.romaji ||
    media.title?.native ||
    media.title?.userPreferred ||
    "Untitled"
  );
};

const parseNumberish = (value: unknown): number | null => {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const parseChapterNumber = (chapter: MapperChapter): number | null => {
  const explicit = parseNumberish(chapter.number);
  if (explicit !== null) return explicit;

  if (!chapter.title) return null;

  const match = chapter.title.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const inferred = Number.parseFloat(match[1]);
  if (!Number.isFinite(inferred)) return null;

  return inferred;
};

const classifyMangaType = (media: AnilistMangaInfo): "manga" | "manhwa" | "manhua" => {
  const country = String(media.countryOfOrigin || "").toUpperCase();
  if (country === "KR") return "manhwa";
  if (country === "CN") return "manhua";
  return "manga";
};

const buildProviderAvailability = (extra: string[] = []) => {
  const merged = new Set<string>([...MANGA_MAPPER_PROVIDERS, ...extra]);
  return [...merged];
};

const toUnifiedMangaTitle = (media: AnilistMangaInfo): UnifiedMangaTitle => {
  return {
    mediaType: classifyMangaType(media),
    anilistId: media.id,
    malId: media.idMal || undefined,
    providerIds: {},
    slugAliases: [],
    canonicalTitle: canonicalTitle(media),
    title: {
      romaji: media.title?.romaji,
      english: media.title?.english,
      native: media.title?.native,
      synonyms: Array.isArray(media.synonyms)
        ? media.synonyms.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [],
    },
    status: toStatus(media.status),
    genres: Array.isArray(media.genres) ? media.genres : [],
    themes: [],
    origin: media.countryOfOrigin || null,
    originLanguage: media.countryOfOrigin || null,
    adult: Boolean(media.isAdult),
    yearStart: media.startDate?.year || null,
    yearEnd: media.endDate?.year || null,
    score: parseNumberish(media.averageScore),
    popularity: parseNumberish(media.popularity),
    coverImage: media.coverImage?.large || media.coverImage?.medium || null,
    providersAvailable: buildProviderAvailability(),
  };
};

const toUnifiedMangaDetail = (media: AnilistMangaInfo, matchedBy: "anilist" | "mal" | "title"): UnifiedMangaDetail => {
  const base = toUnifiedMangaTitle(media);

  return {
    ...base,
    synopsis: media.description ? String(media.description).replace(/<[^>]+>/g, " ").trim() : null,
    authors: [],
    artists: [],
    publishers: [],
    serialization: null,
    totalChapters: parseNumberish(media.chapters),
    totalVolumes: parseNumberish(media.volumes),
    latestChapter: null,
    lastUpdatedAt: null,
    languagesAvailable: ["unknown"],
    providerCoverage: {
      available: buildProviderAvailability(),
      failed: [],
    },
    matchConfidence: matchedBy === "anilist" ? 1 : matchedBy === "mal" ? 0.95 : 0.75,
    matchedBy,
  };
};

const cacheGetJson = async <T>(key: string): Promise<T | null> => {
  const raw = await Cache.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const cacheSetJson = async (key: string, value: unknown, ttl: number) => {
  await Cache.set(key, JSON.stringify(value), ttl);
};

const encodeCanonicalSegment = (value: string) =>
  Buffer.from(String(value || "")).toString("base64url");

const parseTimestampMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readCanonicalSnapshot = async <T>(
  key: string,
  freshMs: number
): Promise<T | null> => {
  if (!canonicalStore.isEnabled()) return null;

  try {
    const snapshot = await canonicalStore.getSnapshotByKey(key);
    if (!snapshot || snapshot.payload === null || snapshot.payload === undefined) {
      return null;
    }

    const refreshedAtMs = parseTimestampMs(snapshot.refreshedAt);
    if (refreshedAtMs !== null) {
      const ageMs = Date.now() - refreshedAtMs;
      if (ageMs > CANONICAL_STALE_MAX_MS) {
        return null;
      }

      if (ageMs > freshMs) {
        logRateLimited("manga:canonical:stale-hit", () => {
          log.info({ key, ageMs }, "using stale canonical manga snapshot");
        }, 120_000);
      }
    }

    return snapshot.payload as T;
  } catch (error) {
    logRateLimited("manga:canonical:read-failed", () => {
      log.warn({ error }, "failed reading canonical manga snapshot");
    }, 15_000);
    return null;
  }
};

const writeCanonicalSnapshot = async (input: {
  key: string;
  routePath: string;
  queryString: string;
  projection: Record<string, unknown>;
  payload: unknown;
  ttlSeconds: number;
}) => {
  if (!canonicalStore.isEnabled()) return;

  const refreshedAt = new Date().toISOString();
  const expiresAt =
    input.ttlSeconds > 0
      ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
      : null;

  try {
    await canonicalStore.upsertSnapshot({
      key: input.key,
      scope: "manga",
      routePath: input.routePath,
      queryString: input.queryString,
      statusCode: 200,
      projection: input.projection,
      payload: input.payload,
      responseHeaders: {},
      sourceMode: "service",
      refreshedAt,
      expiresAt,
    });
  } catch (error) {
    logRateLimited("manga:canonical:write-failed", () => {
      log.warn({ error }, "failed writing canonical manga snapshot");
    }, 15_000);
  }
};

const queueReadImageCandidates = async (
  response: UnifiedReadResponse,
  malId: number | null
) => {
  if (!canonicalStore.isEnabled()) return;

  const provider = String(response.chapter.provider || "").trim().toLowerCase() || null;
  const anilistId = Number.isFinite(Number(response.chapter.anilistId))
    ? Number(response.chapter.anilistId)
    : null;

  const normalizedMalId = Number.isFinite(Number(malId)) ? Number(malId) : null;

  const seen = new Set<string>();
  const candidates = response.pages
    .map((page) => {
      const sourceUrl = String(page.imageUrl || "").trim();
      if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl) || seen.has(sourceUrl)) {
        return null;
      }

      seen.add(sourceUrl);

      return {
        scope: "manga" as const,
        provider,
        anilistId,
        malId: normalizedMalId,
        mediaKind: "image" as const,
        sourceUrl,
        metadata: {
          chapterKey: response.chapter.chapterKey,
          providerChapterId: response.chapter.providerChapterId,
          pageNumber: page.pageNumber,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (candidates.length === 0) return;

  try {
    await canonicalStore.enqueueSourceCandidates(candidates);
  } catch (error) {
    logRateLimited("manga:canonical:queue-image-failed", () => {
      log.warn({ error }, "failed enqueueing manga read image candidates");
    }, 15_000);
  }
};

const resolveFromId = async (resolved: ResolvedMangaId): Promise<{ media: AnilistMangaInfo | null; matchedBy: "anilist" | "mal" | "title" }> => {
  if (resolved.kind === "anilist" && resolved.anilistId) {
    return {
      media: await anilist.getMangaInfo(resolved.anilistId),
      matchedBy: "anilist",
    };
  }

  if (resolved.kind === "mal" && resolved.malId) {
    return {
      media: await anilist.getMangaInfoByMalId(resolved.malId),
      matchedBy: "mal",
    };
  }

  const query = resolved.kind === "provider" ? resolved.providerId : resolved.slug;
  if (!query) {
    return { media: null, matchedBy: "title" };
  }

  const candidates = await anilist.searchManga(query, 1, 10);
  return {
    media: candidates[0] || null,
    matchedBy: "title",
  };
};

const chapterOrder = (value: number | null): number => {
  if (value === null) return Number.MAX_SAFE_INTEGER;
  return Math.round(value * 1000);
};

export interface ParsedChapterKey {
  provider: string;
  chapterId: string;
  chapterNumber: number | null;
}

export const buildChapterKey = (provider: string, chapterId: string, chapterNumber: number | null): string => {
  const safeProvider = provider.toLowerCase();
  const numberPart = chapterNumber === null ? "na" : String(chapterNumber);
  const encodedId = Buffer.from(chapterId).toString("base64url");
  return `${safeProvider}:${numberPart}:${encodedId}`;
};

export const parseChapterKey = (chapterKey: string): ParsedChapterKey | null => {
  const [provider, numberPart, encodedId] = String(chapterKey || "").split(":", 3);
  if (!provider || !encodedId) return null;

  try {
    const chapterId = Buffer.from(encodedId, "base64url").toString("utf-8");
    const chapterNumber = numberPart === "na" ? null : parseNumberish(numberPart);

    if (!chapterId) return null;

    return {
      provider: provider.toLowerCase(),
      chapterId,
      chapterNumber,
    };
  } catch {
    return null;
  }
};

const normalizeChapter = (anilistId: number, provider: string, chapter: MapperChapter): UnifiedChapter => {
  const chapterNumber = parseChapterNumber(chapter);
  const chapterKey = buildChapterKey(provider, chapter.id, chapterNumber);

  return {
    chapterKey,
    anilistId,
    provider,
    providerMangaId: chapter.providerMangaId || null,
    providerChapterId: chapter.id,
    number: chapterNumber,
    volume: parseNumberish(chapter.volume),
    title: chapter.title || null,
    language: chapter.language || null,
    scanlator: chapter.scanlator || null,
    releaseDate: chapter.date || null,
    pageCount: null,
    canonicalOrder: chapterOrder(chapterNumber),
    isOfficial: false,
    isPremium: false,
  };
};

const sortUnifiedChapters = (chapters: UnifiedChapter[]) => {
  return [...chapters].sort((left, right) => {
    if (left.canonicalOrder !== right.canonicalOrder) {
      return left.canonicalOrder - right.canonicalOrder;
    }

    if (left.provider !== right.provider) {
      return left.provider.localeCompare(right.provider);
    }

    return left.providerChapterId.localeCompare(right.providerChapterId);
  });
};

const defaultFilterSchema: UnifiedFilterSchema = {
  facets: [
    {
      key: "type",
      type: "enum",
      options: [
        { value: "manga", label: "Manga", providers: buildProviderAvailability() },
        { value: "manhwa", label: "Manhwa", providers: buildProviderAvailability() },
        { value: "manhua", label: "Manhua", providers: buildProviderAvailability() },
      ],
      unsupportedProviders: [],
    },
    {
      key: "status",
      type: "enum",
      options: [
        { value: "ongoing", label: "Ongoing", providers: buildProviderAvailability() },
        { value: "completed", label: "Completed", providers: buildProviderAvailability() },
        { value: "hiatus", label: "Hiatus", providers: buildProviderAvailability() },
        { value: "cancelled", label: "Cancelled", providers: buildProviderAvailability() },
      ],
      unsupportedProviders: [],
    },
    {
      key: "adult",
      type: "boolean",
      unsupportedProviders: [],
    },
    {
      key: "yearRange",
      type: "range",
      range: {
        min: 1950,
        max: new Date().getFullYear() + 1,
        step: 1,
      },
      unsupportedProviders: [],
    },
    {
      key: "scoreRange",
      type: "range",
      range: {
        min: 0,
        max: 100,
        step: 1,
      },
      unsupportedProviders: [],
    },
    {
      key: "chapterCount",
      type: "range",
      range: {
        min: 0,
        max: 2000,
        step: 1,
      },
      unsupportedProviders: [],
    },
    {
      key: "provider",
      type: "enum",
      options: MANGA_MAPPER_PROVIDERS.map((provider) => ({
        value: provider,
        label: provider,
        providers: [provider],
      })),
      unsupportedProviders: [],
    },
  ],
  sorts: ["relevance", "trending", "latestUpdate", "rating", "popularity", "chapterCount"],
};

export interface MangaSearchResponse {
  query: string;
  page: number;
  limit: number;
  partial: boolean;
  failedProviders: string[];
  results: UnifiedMangaSearchResult[];
}

export interface MangaDetailResponse {
  id: string;
  idResolution: ResolvedMangaId;
  detail: UnifiedMangaDetail;
}

export interface MangaChapterSourceOption {
  provider: string;
  chapterKey: string;
  providerChapterId: string;
  language: string | null;
  scanlator: string | null;
  releaseDate: string | null;
}

export interface MappedMangaChapter {
  chapterNumber: number | null;
  chapterTitle: string | null;
  volume: number | null;
  canonicalOrder: number;
  sources: MangaChapterSourceOption[];
}

export interface MangaProviderMappingStatus {
  provider: string;
  success: boolean;
  error?: string;
  chapterCount: number;
  latencyMs: number;
}

export interface MangaChapterResponse {
  anilistId: number;
  partial: boolean;
  failedProviders: string[];
  chapters: UnifiedChapter[];
  mappedChapters: MappedMangaChapter[];
  providerStatus: MangaProviderMappingStatus[];
}

export interface MangaReadSelection {
  chapterKey?: string;
  provider?: string;
  chapterId?: string;
  chapterNumber?: number | null;
}

export interface MangaReadOrchestrationResult {
  partial: boolean;
  failedProviders: string[];
  response: UnifiedReadResponse | null;
  error?: string;
  guidance?: MangaReadGuidance;
}

export interface MangaReadGuidance {
  code: "NO_PAGES_FOR_CHAPTER" | "MANGADEX_NO_PAGES" | "NO_FALLBACK_PAGES";
  message: string;
  retryable: boolean;
  suggestedProviders?: string[];
  attemptedProviders?: string[];
}

export const getMangaFilterSchema = (): UnifiedFilterSchema => defaultFilterSchema;

const toSearchResult = (media: AnilistMangaInfo, query: string): UnifiedMangaSearchResult => {
  const base = toUnifiedMangaTitle(media);
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTitle = base.canonicalTitle.trim().toLowerCase();

  let matchConfidence = 0.7;
  if (normalizedTitle === normalizedQuery) {
    matchConfidence = 1;
  } else if (normalizedTitle.includes(normalizedQuery)) {
    matchConfidence = 0.9;
  }

  return {
    mediaType: base.mediaType,
    anilistId: base.anilistId,
    malId: base.malId,
    canonicalTitle: base.canonicalTitle,
    title: {
      romaji: base.title.romaji,
      english: base.title.english,
      native: base.title.native,
    },
    poster: base.coverImage,
    status: base.status,
    year: base.yearStart,
    score: base.score,
    popularity: base.popularity,
    adult: base.adult,
    providersAvailable: base.providersAvailable,
    matchConfidence,
    chapters: parseNumberish(media.chapters),
    volumes: parseNumberish(media.volumes),
    originLanguage: base.originLanguage,
    readingDirection: "unknown",
  };
};

export const searchManga = async (
  query: string,
  page: number = 1,
  limit: number = 24
): Promise<MangaSearchResponse> => {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return {
      query: "",
      page,
      limit,
      partial: false,
      failedProviders: [],
      results: [],
    };
  }

  const key = `manga:search:${normalizedQuery.toLowerCase()}:${page}:${limit}`;
  const cached = await cacheGetJson<MangaSearchResponse>(key);
  if (cached) return cached;

  const results = await anilist.searchManga(normalizedQuery, page, limit);
  const response: MangaSearchResponse = {
    query: normalizedQuery,
    page,
    limit,
    partial: false,
    failedProviders: [],
    results: results.map((item) => toSearchResult(item, normalizedQuery)),
  };

  await cacheSetJson(key, response, SEARCH_TTL_SECONDS);
  return response;
};

export const getMangaDetail = async (
  id: string,
  options: MangaCacheControlOptions = {}
): Promise<MangaDetailResponse | null> => {
  const resolved = resolveMangaId(id);
  if (!resolved) return null;

  const forceFresh = Boolean(options.forceFresh);

  const cacheKey = `manga:detail:${resolved.raw.toLowerCase()}`;
  if (forceFresh) {
    await Cache.del(cacheKey);
  } else {
    const cached = await cacheGetJson<MangaDetailResponse>(cacheKey);
    if (cached) return cached;
  }

  const { media, matchedBy } = await resolveFromId(resolved);
  if (!media) return null;

  const response: MangaDetailResponse = {
    id,
    idResolution: {
      ...resolved,
      anilistId: media.id,
      malId: media.idMal || resolved.malId,
    },
    detail: toUnifiedMangaDetail(media, matchedBy),
  };

  if (!forceFresh) {
    await cacheSetJson(cacheKey, response, DETAIL_TTL_SECONDS);
  }
  return response;
};

const mappedChapterGroupKey = (chapter: UnifiedChapter) => {
  const numberPart = chapter.number === null ? "na" : String(chapter.number);
  const titlePart = String(chapter.title || "").trim().toLowerCase();
  return `${numberPart}::${titlePart}`;
};

const buildMappedChapters = (chapters: UnifiedChapter[]): MappedMangaChapter[] => {
  const grouped = new Map<string, UnifiedChapter[]>();

  for (const chapter of chapters) {
    const key = mappedChapterGroupKey(chapter);
    const current = grouped.get(key);
    if (current) {
      current.push(chapter);
    } else {
      grouped.set(key, [chapter]);
    }
  }

  return [...grouped.values()]
    .map((group) => {
      const first = group[0];
      return {
        chapterNumber: first.number,
        chapterTitle: first.title,
        volume: first.volume,
        canonicalOrder: first.canonicalOrder,
        sources: group.map((chapter) => ({
          provider: chapter.provider,
          chapterKey: chapter.chapterKey,
          providerChapterId: chapter.providerChapterId,
          language: chapter.language,
          scanlator: chapter.scanlator,
          releaseDate: chapter.releaseDate,
        })),
      };
    })
    .sort((left, right) => left.canonicalOrder - right.canonicalOrder);
};

const uniqueProviders = (providers: string[]) => {
  return [...new Set(providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean))];
};

export const getMangaChapters = async (
  id: string,
  options: { providers?: string[]; language?: string; forceFresh?: boolean } = {}
): Promise<MangaChapterResponse | null> => {
  const forceFresh = Boolean(options.forceFresh);
  const detail = await getMangaDetail(id, { forceFresh });
  if (!detail) return null;

  const requestedProviders = uniqueProviders(options.providers && options.providers.length > 0
    ? options.providers
    : [...MANGA_MAPPER_PROVIDERS]);
  const mappedProviders = requestedProviders.filter((provider) => isSupportedMangaMapperProvider(provider));
  const unsupportedProviders = requestedProviders.filter((provider) => !isSupportedMangaMapperProvider(provider));

  if (mappedProviders.length === 0) {
    return {
      anilistId: detail.detail.anilistId,
      partial: true,
      failedProviders: [...unsupportedProviders],
      chapters: [],
      mappedChapters: [],
      providerStatus: requestedProviders.map((provider) => ({
        provider,
        success: false,
        error: "Provider not supported",
        chapterCount: 0,
        latencyMs: 0,
      })),
    };
  }

  const providerKey = requestedProviders.join(",");
  const languageKey = options.language || "all";
  const cacheKey = `manga:chapters:${detail.detail.anilistId}:${providerKey}:${languageKey}`;
  const canonicalKey = `canonical:manga:chapters:v1:${detail.detail.anilistId}:${encodeCanonicalSegment(providerKey)}:${encodeCanonicalSegment(languageKey)}`;

  if (forceFresh) {
    await Cache.del(cacheKey);
    if (canonicalStore.isEnabled()) {
      try {
        await canonicalStore.deleteSnapshotByKey(canonicalKey);
      } catch {
        // Ignore snapshot purge failures during force refresh.
      }
    }
  } else {
    const cached = await cacheGetJson<MangaChapterResponse>(cacheKey);
    if (cached) return cached;

    const canonicalCached = await readCanonicalSnapshot<MangaChapterResponse>(
      canonicalKey,
      CHAPTER_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
      await cacheSetJson(cacheKey, canonicalCached, CHAPTER_TTL_SECONDS);
      return canonicalCached;
    }
  }

  const mapperResults = await fetchAllMapperChapters(
    detail.detail.anilistId,
    mappedProviders,
    options.language
  );

  const chapters: UnifiedChapter[] = mapperResults.success.flatMap((successResult) =>
    successResult.data.map((chapter) => normalizeChapter(detail.detail.anilistId, successResult.provider, chapter))
  );

  const normalizedLanguage = options.language?.toLowerCase();
  const languageFiltered = normalizedLanguage
    ? chapters.filter((chapter) => String(chapter.language || "").toLowerCase() === normalizedLanguage)
    : chapters;

  const sortedChapters = sortUnifiedChapters(languageFiltered);

  const mapperFailedByProvider = new Map(
    mapperResults.failed.map((failedResult) => [failedResult.provider.toLowerCase(), failedResult])
  );
  const mapperSuccessByProvider = new Map(
    mapperResults.success.map((successResult) => [successResult.provider.toLowerCase(), successResult])
  );

  const providerStatus: MangaProviderMappingStatus[] = requestedProviders.map((provider) => {
    const success = mapperSuccessByProvider.get(provider);
    if (success) {
      return {
        provider,
        success: true,
        chapterCount: success.data.length,
        latencyMs: success.latencyMs,
      };
    }

    const failed = mapperFailedByProvider.get(provider);
    if (failed) {
      return {
        provider,
        success: false,
        error: failed.error || "Provider mapping failed",
        chapterCount: 0,
        latencyMs: failed.latencyMs,
      };
    }

    return {
      provider,
      success: false,
      error: "Provider not supported",
      chapterCount: 0,
      latencyMs: 0,
    };
  });

  const failedProviders = uniqueProviders([
    ...mapperResults.failed.map((failedResult) => failedResult.provider),
    ...unsupportedProviders,
  ]);

  const response: MangaChapterResponse = {
    anilistId: detail.detail.anilistId,
    partial: failedProviders.length > 0,
    failedProviders,
    chapters: sortedChapters,
    mappedChapters: buildMappedChapters(sortedChapters),
    providerStatus,
  };

  if (!forceFresh) {
    await cacheSetJson(cacheKey, response, CHAPTER_TTL_SECONDS);
    await writeCanonicalSnapshot({
      key: canonicalKey,
      routePath: "/internal/manga/chapters",
      queryString: `anilistId=${detail.detail.anilistId}&providers=${providerKey}&language=${languageKey}`,
      projection: {
        anilistId: detail.detail.anilistId,
        chapterCount: response.chapters.length,
        mappedChapterCount: response.mappedChapters.length,
        failedProviders: response.failedProviders,
        providers: requestedProviders,
        language: options.language || null,
        partial: response.partial,
      },
      payload: response,
      ttlSeconds: CHAPTER_TTL_SECONDS,
    });
  }
  return response;
};

const toReadPages = (pages: { url: string; index?: number; width?: number; height?: number }[]): UnifiedReadPage[] => {
  return pages
    .map((page, index) => ({
      pageNumber: Number.isFinite(Number(page.index)) ? Number(page.index) + 1 : index + 1,
      imageUrl: page.url,
      proxiedImageUrl: null,
      width: Number.isFinite(Number(page.width)) ? Number(page.width) : null,
      height: Number.isFinite(Number(page.height)) ? Number(page.height) : null,
    }))
    .sort((left, right) => left.pageNumber - right.pageNumber);
};

const buildReadResponse = (
  chapter: UnifiedChapter,
  pages: UnifiedReadPage[],
  failedProviders: string[],
  fallbackUsed = false
): UnifiedReadResponse => {
  return {
    chapter: {
      chapterKey: chapter.chapterKey,
      anilistId: chapter.anilistId,
      provider: chapter.provider,
      providerChapterId: chapter.providerChapterId,
      number: chapter.number,
      title: chapter.title,
      language: chapter.language,
    },
    pages,
    readMeta: {
      provider: chapter.provider,
      fetchedAt: new Date().toISOString(),
      expiresAt: null,
      retryAfter: null,
      fallbackUsed,
      failedProviders,
    },
  };
};

const uniqueStrings = (values: string[]) => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];

const chapterNumbersMatch = (left: number | null, right: number | null) => {
  if (left === null || right === null) return false;
  return Math.abs(left - right) < 0.0001;
};

interface MangaReadFallbackCandidate {
  provider: string;
  chapterId: string;
  chapterNumber: number | null;
  chapter?: UnifiedChapter;
}

const buildMangaReadGuidance = (
  primaryProvider: string,
  baseError: string,
  suggestedProviders: string[],
  attemptedProviders: string[]
): MangaReadGuidance => {
  const noPagesFound = /no chapter pages found/i.test(baseError);

  if (primaryProvider === "mangadex" && noPagesFound) {
    return {
      code: "MANGADEX_NO_PAGES",
      message:
        "MangaDex returned chapter metadata but no readable page payload for this chapter right now. Retry later or switch to another provider for the same chapter.",
      retryable: true,
      suggestedProviders,
      attemptedProviders,
    };
  }

  if (noPagesFound) {
    return {
      code: "NO_PAGES_FOR_CHAPTER",
      message:
        "The selected chapter currently has no readable pages from the attempted providers. Retry later or switch provider.",
      retryable: true,
      suggestedProviders,
      attemptedProviders,
    };
  }

  return {
    code: "NO_FALLBACK_PAGES",
    message:
      "The chapter read request failed and fallback providers were unavailable for this chapter. Retry later.",
    retryable: true,
    suggestedProviders,
    attemptedProviders,
  };
};

export const getMangaRead = async (
  id: string,
  selection: MangaReadSelection,
  options: MangaCacheControlOptions = {}
): Promise<MangaReadOrchestrationResult> => {
  const forceFresh = Boolean(options.forceFresh);
  let provider: string;
  let chapterId: string;
  let chapterNumber: number | null;

  if (selection.chapterKey) {
    const parsed = parseChapterKey(selection.chapterKey);
    if (!parsed) {
      return {
        partial: true,
        failedProviders: [],
        response: null,
        error: "Invalid chapter key",
      };
    }

    provider = parsed.provider;
    chapterId = parsed.chapterId;
    chapterNumber = parsed.chapterNumber;
  } else if (selection.provider && selection.chapterId) {
    provider = selection.provider.toLowerCase();
    chapterId = selection.chapterId;
    chapterNumber = selection.chapterNumber ?? null;
  } else {
    return {
      partial: true,
      failedProviders: [],
      response: null,
      error: "Selection must include chapterKey or provider + chapterId",
    };
  }

  if (!isSupportedMangaMapperProvider(provider)) {
    return {
      partial: true,
      failedProviders: [provider],
      response: null,
      error: `Provider not supported: ${provider}`,
    };
  }

  const detail = await getMangaDetail(id, { forceFresh });
  if (!detail) {
    return {
      partial: true,
      failedProviders: [],
      response: null,
      error: "Manga not found",
    };
  }

  const chapterKey = buildChapterKey(provider, chapterId, chapterNumber);
  const readCacheKey = `manga:read:${detail.detail.anilistId}:${provider}:${chapterId}`;
  const canonicalReadKey = `canonical:manga:read:v1:${detail.detail.anilistId}:${encodeCanonicalSegment(provider)}:${encodeCanonicalSegment(chapterId)}`;

  if (forceFresh) {
    await Cache.del(readCacheKey);
    if (canonicalStore.isEnabled()) {
      try {
        await canonicalStore.deleteSnapshotByKey(canonicalReadKey);
      } catch {
        // Ignore snapshot purge failures during force refresh.
      }
    }
  } else {
    const cached = await cacheGetJson<UnifiedReadResponse>(readCacheKey);
    if (cached) {
      return {
        partial: false,
        failedProviders: [],
        response: cached,
      };
    }

    const canonicalCached = await readCanonicalSnapshot<UnifiedReadResponse>(
      canonicalReadKey,
      READ_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
      await cacheSetJson(readCacheKey, canonicalCached, READ_TTL_SECONDS);
      return {
        partial: false,
        failedProviders: [],
        response: canonicalCached,
      };
    }
  }

  const selected = await fetchMapperPages(provider, chapterId);
  if (selected.ok && selected.data.length > 0) {
    const chapter: UnifiedChapter = {
      chapterKey,
      anilistId: detail.detail.anilistId,
      provider,
      providerMangaId: null,
      providerChapterId: chapterId,
      number: chapterNumber,
      volume: null,
      title: null,
      language: null,
      scanlator: null,
      releaseDate: null,
      pageCount: selected.data.length,
      canonicalOrder: chapterOrder(chapterNumber),
      isOfficial: false,
      isPremium: false,
    };

    const response = buildReadResponse(chapter, toReadPages(selected.data), [], false);
    if (!forceFresh) {
      await cacheSetJson(readCacheKey, response, READ_TTL_SECONDS);
      await writeCanonicalSnapshot({
        key: canonicalReadKey,
        routePath: "/internal/manga/read",
        queryString: `anilistId=${detail.detail.anilistId}&provider=${provider}&chapterId=${encodeURIComponent(chapterId)}`,
        projection: {
          anilistId: detail.detail.anilistId,
          provider,
          chapterKey: response.chapter.chapterKey,
          pageCount: response.pages.length,
          partial: false,
          fallbackUsed: false,
        },
        payload: response,
        ttlSeconds: READ_TTL_SECONDS,
      });
    }
    await queueReadImageCandidates(response, detail.detail.malId ?? null);
    return {
      partial: false,
      failedProviders: [],
      response,
    };
  }

  const failedProviders: string[] = [provider];
  const attemptedProviders: string[] = [provider];
  const fallbackCandidates: MangaReadFallbackCandidate[] = [];

  if (chapterNumber !== null) {
    const chapterIndex = await getMangaChapters(id);
    if (chapterIndex) {
      const exactMappedChapter = chapterIndex.mappedChapters.find((group) =>
        chapterNumbersMatch(group.chapterNumber, chapterNumber) &&
        group.sources.some(
          (source) => source.provider === provider && source.providerChapterId === chapterId
        )
      );

      if (exactMappedChapter) {
        for (const source of exactMappedChapter.sources) {
          if (source.provider === provider && source.providerChapterId === chapterId) continue;
          const chapter = chapterIndex.chapters.find(
            (candidate) =>
              candidate.provider === source.provider &&
              candidate.providerChapterId === source.providerChapterId
          );

          fallbackCandidates.push({
            provider: source.provider,
            chapterId: source.providerChapterId,
            chapterNumber: exactMappedChapter.chapterNumber,
            chapter,
          });
        }
      }

      for (const chapter of chapterIndex.chapters) {
        if (chapter.provider === provider && chapter.providerChapterId === chapterId) continue;
        if (!chapterNumbersMatch(chapter.number, chapterNumber)) continue;

        fallbackCandidates.push({
          provider: chapter.provider,
          chapterId: chapter.providerChapterId,
          chapterNumber: chapter.number,
          chapter,
        });
      }
    }
  }

  const dedupedCandidates: MangaReadFallbackCandidate[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of fallbackCandidates) {
    const key = `${candidate.provider}:${candidate.chapterId}`;
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    dedupedCandidates.push(candidate);
  }

  const maxFallbackAttempts = 8;
  for (const candidate of dedupedCandidates.slice(0, maxFallbackAttempts)) {
    attemptedProviders.push(candidate.provider);
    const fallbackResult = await fetchMapperPages(candidate.provider, candidate.chapterId);
    if (fallbackResult.ok && fallbackResult.data.length > 0) {
      const resolvedChapter: UnifiedChapter = candidate.chapter || {
        chapterKey: buildChapterKey(candidate.provider, candidate.chapterId, candidate.chapterNumber),
        anilistId: detail.detail.anilistId,
        provider: candidate.provider,
        providerMangaId: null,
        providerChapterId: candidate.chapterId,
        number: candidate.chapterNumber,
        volume: null,
        title: null,
        language: null,
        scanlator: null,
        releaseDate: null,
        pageCount: fallbackResult.data.length,
        canonicalOrder: chapterOrder(candidate.chapterNumber),
        isOfficial: false,
        isPremium: false,
      };

      const normalizedFailedProviders = uniqueStrings(failedProviders);
      const response = buildReadResponse(
        resolvedChapter,
        toReadPages(fallbackResult.data),
        normalizedFailedProviders,
        true
      );

      if (!forceFresh) {
        await cacheSetJson(readCacheKey, response, READ_TTL_SECONDS);
        await writeCanonicalSnapshot({
          key: canonicalReadKey,
          routePath: "/internal/manga/read",
          queryString: `anilistId=${detail.detail.anilistId}&provider=${resolvedChapter.provider}&chapterId=${encodeURIComponent(resolvedChapter.providerChapterId)}`,
          projection: {
            anilistId: detail.detail.anilistId,
            provider: resolvedChapter.provider,
            chapterKey: response.chapter.chapterKey,
            pageCount: response.pages.length,
            partial: true,
            fallbackUsed: true,
            failedProviders: normalizedFailedProviders,
          },
          payload: response,
          ttlSeconds: READ_TTL_SECONDS,
        });
      }
      await queueReadImageCandidates(response, detail.detail.malId ?? null);
      return {
        partial: true,
        failedProviders: normalizedFailedProviders,
        response,
      };
    }

    failedProviders.push(candidate.provider);
  }

  const normalizedFailedProviders = uniqueStrings(failedProviders);
  const normalizedAttemptedProviders = uniqueStrings(attemptedProviders);
  const suggestedProviders = uniqueStrings(
    dedupedCandidates
      .map((candidate) => candidate.provider)
      .filter((candidateProvider) => candidateProvider !== provider)
  );
  const baseError = selected.error || "Failed to fetch chapter pages";
  const guidance = buildMangaReadGuidance(
    provider,
    baseError,
    suggestedProviders,
    normalizedAttemptedProviders
  );
  const suggestionSuffix = suggestedProviders.length > 0
    ? ` Try provider(s): ${suggestedProviders.join(", ")}.`
    : "";

  return {
    partial: true,
    failedProviders: normalizedFailedProviders,
    response: null,
    error: `${baseError}${suggestionSuffix}`,
    guidance,
  };
};

const addFacetCount = (
  buckets: Map<string, Map<string, { count: number; providers: Set<string> }>>,
  facet: string,
  value: string,
  providers: string[]
) => {
  if (!value) return;

  if (!buckets.has(facet)) {
    buckets.set(facet, new Map());
  }

  const facetBucket = buckets.get(facet)!;
  if (!facetBucket.has(value)) {
    facetBucket.set(value, {
      count: 0,
      providers: new Set<string>(),
    });
  }

  const target = facetBucket.get(value)!;
  target.count += 1;
  for (const provider of providers) {
    target.providers.add(provider);
  }
};

export const getMangaFacetCounts = async (query: string): Promise<FacetCounts> => {
  const search = await searchManga(query, 1, 50);
  const buckets = new Map<string, Map<string, { count: number; providers: Set<string> }>>();

  for (const item of search.results) {
    addFacetCount(buckets, "type", item.mediaType, item.providersAvailable);
    addFacetCount(buckets, "status", item.status, item.providersAvailable);
    addFacetCount(buckets, "origin", String(item.originLanguage || "unknown"), item.providersAvailable);

    for (const provider of item.providersAvailable) {
      addFacetCount(buckets, "provider", provider, [provider]);
    }
  }

  const groups: FacetCountGroup[] = [...buckets.entries()].map(([key, valueMap]) => {
    const counts = [...valueMap.entries()]
      .map(([value, countRow]) => ({
        value,
        count: countRow.count,
        providers: [...countRow.providers].sort(),
      }))
      .sort((left, right) => {
        if (left.count !== right.count) {
          return right.count - left.count;
        }

        return left.value.localeCompare(right.value);
      });

    const coverageRatio = search.results.length === 0 ? 1 : Math.min(1, counts.reduce((sum, row) => sum + row.count, 0) / search.results.length);

    return {
      key,
      counts,
      coverageRatio,
      partial: search.partial,
    };
  });

  return {
    query,
    groups,
  };
};
