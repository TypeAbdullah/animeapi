
import { Hono } from "hono";
import { AnimepaheMapper } from "./animepahe.js";
import { HianimeMapper } from "./hianime.js";
import { AnimeKaiMapper } from "./animekai.js";
import { AniList } from "./anilist.js";
import { search as desidubSearch } from "../desidubanime/desidubanime.js";
import { search as toonworldSearch } from "../toonworld/toonworld.js";
import { cache } from "../../config/cache.js";
import {
  MANGA_MAPPER_PROVIDERS,
  fetchMapperChapters,
  fetchMapperPages,
  getMapperBridgeConfig,
  isSupportedMangaMapperProvider,
} from "../manga/mapperBridge.js";

export const mapperRoutes = new Hono();
const anilist = new AniList();

const parsePositiveInteger = (value: string): number | null => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();

const ANIME_MAPPING_DB_TTL_SECONDS = 30 * 24 * 60 * 60;
const ANIME_MAPPING_DB_STALE_SECONDS = 7 * 24 * 60 * 60;
const NON_CACHEABLE_MAPPING_ERROR = "NON_CACHEABLE_MAPPING";

type MappingResponse = {
  status: number;
  body: Record<string, unknown>;
  cacheable?: boolean;
};

const hasValidMappingId = (body: Record<string, unknown>) => {
  const id = body?.id;
  if (typeof id === "number") return Number.isFinite(id) && id > 0;
  if (typeof id === "string") return id.trim().length > 0;
  return false;
};

const buildAnimeMappingDbKey = (provider: string, anilistId: number) =>
  `anime:mapping-db:v1:${provider}:${anilistId}`;

const resolveWithMappingDb = async (
  provider: string,
  anilistId: number,
  resolver: () => Promise<MappingResponse>
): Promise<MappingResponse> => {
  const key = buildAnimeMappingDbKey(provider, anilistId);

  try {
    const body = await cache.getOrSet<Record<string, unknown>>(
      async () => {
        const resolved = await resolver();
        if (resolved.status !== 200 || resolved.cacheable === false || !hasValidMappingId(resolved.body)) {
          throw new Error(NON_CACHEABLE_MAPPING_ERROR);
        }
        return resolved.body;
      },
      key,
      ANIME_MAPPING_DB_TTL_SECONDS,
      {
        staleWhileRevalidateSeconds: ANIME_MAPPING_DB_STALE_SECONDS,
        allowStaleOnError: true,
      }
    );

    return { status: 200, body };
  } catch (error: any) {
    if (error?.message === NON_CACHEABLE_MAPPING_ERROR) {
      return resolver();
    }

    // If Redis/cache is unavailable, continue with live resolution.
    return resolver();
  }
};

mapperRoutes.get("/map/:provider/:anilistId", async (c) => {
  const provider = c.req.param("provider");
  const normalizedProvider = provider.toLowerCase();
  const anilistId = parseInt(c.req.param("anilistId"));

  if (isNaN(anilistId)) {
    return c.json({ status: 400, message: "Invalid AniList ID" }, 400);
  }

  try {
    const withTimeout = async <T>(promise: Promise<T>, ms: number, defaultValue: T): Promise<T> => {
      const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(defaultValue), ms));
      return Promise.race([promise, timeout]);
    };

    const result = await resolveWithMappingDb(normalizedProvider, anilistId, async (): Promise<MappingResponse> => {
      switch (normalizedProvider) {
        case "animepahe": {
          const mapper = new AnimepaheMapper();
          const mapped = (await mapper.mapAnilistToAnimePahe(anilistId)) as Record<string, unknown>;
          if (!hasValidMappingId(mapped)) {
            return {
              status: 404,
              body: { status: 404, message: "Unable to map AniList ID to animepahe" },
              cacheable: false,
            };
          }
          return { status: 200, body: mapped };
        }
        case "hianime": {
          const mapper = new HianimeMapper();
          const mapped = (await mapper.mapAnilistToHiAnime(anilistId)) as Record<string, unknown>;
          if (!hasValidMappingId(mapped)) {
            return {
              status: 404,
              body: { status: 404, message: "Unable to map AniList ID to hianime" },
              cacheable: false,
            };
          }
          return { status: 200, body: mapped };
        }
        case "animekai": {
          const mapper = new AnimeKaiMapper();
          const mapped = (await mapper.mapAnilistToAnimeKai(anilistId)) as Record<string, unknown>;
          if (!hasValidMappingId(mapped)) {
            return {
              status: 404,
              body: { status: 404, message: "Unable to map AniList ID to animekai" },
              cacheable: false,
            };
          }
          return { status: 200, body: mapped };
        }
        case "animelok":
        case "animeya": {
          return { status: 200, body: { id: anilistId } };
        }
        case "watchaw":
        case "aniworld":
        case "anilisthindi": {
          const info = await anilist.getAnimeInfo(anilistId);
          if (!info) {
            return {
              status: 404,
              body: { status: 404, message: "Anime not found on AniList" },
              cacheable: false,
            };
          }
          const title = info?.title.english || info?.title.romaji || info?.title.userPreferred || "";
          return { status: 200, body: { id: slugify(title) } };
        }
        case "desidub":
        case "desidubanime": {
          const info = await anilist.getAnimeInfo(anilistId);
          if (!info) {
            return {
              status: 404,
              body: { status: 404, message: "Anime not found on AniList" },
              cacheable: false,
            };
          }

          const title = info.title.english || info.title.romaji || "";
          if (title) {
            try {
              const res = await withTimeout(desidubSearch(title), 1200, null);
              if (res?.results?.length) {
                return { status: 200, body: { id: res.results[0].slug } };
              }
            } catch {
              // fallback
            }
          }

          return { status: 200, body: { id: slugify(title) } };
        }
        case "toonworld": {
          const info = await anilist.getAnimeInfo(anilistId);
          if (!info) {
            return {
              status: 404,
              body: { status: 404, message: "Anime not found on AniList" },
              cacheable: false,
            };
          }

          const title = info.title.english || info.title.romaji || "";
          if (title) {
            try {
              const res = await withTimeout(toonworldSearch(title), 1200, null);
              if (Array.isArray(res) && res.length) {
                return { status: 200, body: { id: res[0].slug } };
              }
            } catch {
              // fallback
            }
          }

          return { status: 200, body: { id: slugify(title) } };
        }
        case "hindidubbed":
        case "toonstream": {
          const info = await anilist.getAnimeInfo(anilistId);
          if (!info) {
            return {
              status: 404,
              body: { status: 404, message: "Anime not found on AniList" },
              cacheable: false,
            };
          }
          const title = info?.title.english || info?.title.romaji || info?.title.userPreferred || "";
          return { status: 200, body: { id: slugify(title) } };
        }
        default:
          return {
            status: 404,
            body: { status: 404, message: `Mapper not implemented for provider: ${provider}` },
            cacheable: false,
          };
      }
    });

    return c.json(result.body, result.status as 200 | 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503);
  } catch (error: any) {
    console.error(`[Mapper Error] Provider: ${provider}, ID: ${anilistId}, Error:`, error);
    return c.json({ 
      status: 500, 
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined 
    }, 500);
  }
});

mapperRoutes.get("/manga/providers", (c) => {
  return c.json({
    service: "manga-mapper-bridge",
    providers: MANGA_MAPPER_PROVIDERS,
    config: getMapperBridgeConfig(),
  });
});

mapperRoutes.get("/manga/:provider/chapters/:anilistId", async (c) => {
  const provider = c.req.param("provider").toLowerCase();
  const anilistId = parsePositiveInteger(c.req.param("anilistId"));

  if (!isSupportedMangaMapperProvider(provider)) {
    return c.json({ status: 404, message: `Unsupported manga mapper provider: ${provider}` }, 404);
  }

  if (!anilistId) {
    return c.json({ status: 400, message: "Invalid AniList ID" }, 400);
  }

  const result = await fetchMapperChapters(provider, anilistId);
  if (!result.ok) {
    return c.json(
      {
        status: result.status,
        message: result.error || "Failed to fetch chapter list from mapper",
        provider,
        anilistId,
      },
      result.status as 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503
    );
  }

  return c.json({
    success: true,
    provider,
    anilistId,
    chapters: result.data,
    meta: {
      latencyMs: result.latencyMs,
    },
  });
});

const handleMangaMapperPages = async (provider: string, chapterId: string, c: any) => {
  const normalizedProvider = provider.toLowerCase();
  if (!isSupportedMangaMapperProvider(normalizedProvider)) {
    return c.json({ status: 404, message: `Unsupported manga mapper provider: ${normalizedProvider}` }, 404);
  }

  if (!chapterId) {
    return c.json({ status: 400, message: "Missing chapterId" }, 400);
  }

  const result = await fetchMapperPages(normalizedProvider, chapterId);
  if (!result.ok) {
    return c.json(
      {
        status: result.status,
        message: result.error || "Failed to fetch chapter pages from mapper",
        provider: normalizedProvider,
      },
      result.status as 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503
    );
  }

  return c.json({
    success: true,
    provider: normalizedProvider,
    chapterId,
    pages: result.data,
    meta: {
      latencyMs: result.latencyMs,
    },
  });
};

mapperRoutes.get("/manga/:provider/pages", async (c) => {
  const provider = c.req.param("provider");
  const chapterId = String(c.req.query("chapterId") || "").trim();
  return handleMangaMapperPages(provider, chapterId, c);
});

mapperRoutes.get("/manga/:provider/pages/:chapterId", async (c) => {
  const provider = c.req.param("provider");
  const chapterId = decodeURIComponent(c.req.param("chapterId"));
  return handleMangaMapperPages(provider, chapterId, c);
});

mapperRoutes.get("/", (c) => {
  return c.json({
    service: "mapper",
    description: "Anilist to provider ID mapping service",
    supported_providers: [
      "animepahe",
      "hianime",
      "animekai",
      "animelok",
      "animeya",
      "watchaw",
      "aniworld",
      "desidub",
      "hindidubbed",
      "toonstream",
    ],
    manga_mapper_bridge: {
      providers: MANGA_MAPPER_PROVIDERS,
      endpoints: [
        "/manga/providers",
        "/manga/:provider/chapters/:anilistId",
        "/manga/:provider/pages?chapterId=...",
        "/manga/:provider/pages/:chapterId",
      ],
    },
  });
});
