import { Hono } from "hono";
import { HiAnime } from "../vendor/aniwatch/index.js";
import type * as AniwatchTypes from "../vendor/aniwatch/types/index.js";
import type { AZListSortOptions } from "../vendor/aniwatch/utils/constants.js";
import { cache } from "../config/cache.js";
import { isVerboseLoggingEnabled, log, logRateLimited } from "../config/logger.js";
import type { ServerContext } from "../config/context.js";
import { extractCompatStreamingInfo } from "../services/hianimeCompat.js";
import { canonicalStore } from "../lib/canonicalStore.js";

const hianime = new HiAnime.Scraper();
const tatakaiRouter = new Hono<ServerContext>();

const META_RESOLVE_CONCURRENCY = 6;
const HIANIME_INFO_TIMEOUT_MS = 12000;
const HIANIME_INFO_RETRY_COUNT = 2;

type IdPair = {
    anilistID: number | null;
    malID: number | null;
};

type AnimeMeta = IdPair & {
    poster: string | null;
    banner: string | null;
};

type TimedValue<T> = {
    value: T;
    expiresAt: number;
};

const META_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const POSTER_LOOKUP_TTL_MS = 12 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX_ENTRIES = 4000;
const EPISODE_SOURCE_CANONICAL_FRESH_MS = 12 * 60 * 60 * 1000;
const EPISODE_SOURCE_CANONICAL_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const META_UPSTREAM_FAILURE_THRESHOLD = 8;
const META_UPSTREAM_DEGRADED_TTL_MS = 2 * 60 * 1000;
let metaUpstreamFailureStreak = 0;
let metaUpstreamDegradedUntil = 0;

const animeMetaLookupCache = new Map<string, TimedValue<AnimeMeta>>();
const animeMetaLookupInflight = new Map<string, Promise<AnimeMeta>>();
const anilistPosterLookupCache = new Map<
    string,
    TimedValue<{ poster: string | null; banner: string | null } | null>
>();
const anilistPosterLookupInflight = new Map<string, Promise<{ poster: string | null; banner: string | null } | null>>();

const evictOldestIfNeeded = <T>(cacheMap: Map<string, TimedValue<T>>) => {
    if (cacheMap.size <= LOOKUP_CACHE_MAX_ENTRIES) return;
    const firstKey = cacheMap.keys().next().value;
    if (firstKey) cacheMap.delete(firstKey);
};

const setTimedCacheValue = <T>(
    cacheMap: Map<string, TimedValue<T>>,
    key: string,
    value: T,
    ttlMs: number
) => {
    cacheMap.set(key, { value, expiresAt: Date.now() + ttlMs });
    evictOldestIfNeeded(cacheMap);
};

const getTimedCacheValue = <T>(
    cacheMap: Map<string, TimedValue<T>>,
    key: string
): T | undefined => {
    const cached = cacheMap.get(key);
    if (!cached) return undefined;
    if (Date.now() > cached.expiresAt) {
        cacheMap.delete(key);
        return undefined;
    }
    return cached.value;
};

const encodeCanonicalSegment = (value: string) =>
    Buffer.from(String(value || "")).toString("base64url");

const parseTimestampMs = (value: string | null | undefined): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const buildEpisodeCanonicalKey = (
    kind: "sources" | "stream",
    animeEpisodeId: string,
    server: string,
    category: "sub" | "dub" | "raw"
) => {
    return [
        "canonical:hianime",
        kind,
        "v1",
        encodeCanonicalSegment(animeEpisodeId),
        encodeCanonicalSegment(server.toLowerCase()),
        encodeCanonicalSegment(category),
    ].join(":");
};

const buildEpisodeServersCanonicalKey = (animeEpisodeId: string) => {
    return [
        "canonical:hianime",
        "episode-servers",
        "v1",
        encodeCanonicalSegment(animeEpisodeId),
    ].join(":");
};

const buildAnimeEpisodesCanonicalKey = (animeId: string) => {
    return [
        "canonical:hianime",
        "anime-episodes",
        "v1",
        encodeCanonicalSegment(animeId),
    ].join(":");
};

const buildNextEpisodeScheduleCanonicalKey = (animeId: string) => {
    return [
        "canonical:hianime",
        "next-episode-schedule",
        "v1",
        encodeCanonicalSegment(animeId),
    ].join(":");
};

const readEpisodeCanonicalSnapshot = async <T>(
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
            if (ageMs > EPISODE_SOURCE_CANONICAL_STALE_MAX_MS) {
                return null;
            }

            if (ageMs > freshMs) {
                logRateLimited("hianime:canonical:stale-hit", () => {
                    log.info({ key, ageMs }, "using stale canonical hianime episode snapshot");
                }, 120_000);
            }
        }

        return snapshot.payload as T;
    } catch (error) {
        logRateLimited("hianime:canonical:read-failed", () => {
            log.warn(
                { error: (error as Error)?.message || String(error) },
                "failed reading canonical hianime episode snapshot"
            );
        }, 15_000);
        return null;
    }
};

const writeEpisodeCanonicalSnapshot = async (input: {
    key: string;
    routePath: string;
    queryString: string;
    payload: unknown;
    projection: Record<string, unknown>;
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
            scope: "hianime",
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
        logRateLimited("hianime:canonical:write-failed", () => {
            log.warn(
                { error: (error as Error)?.message || String(error) },
                "failed writing canonical hianime episode snapshot"
            );
        }, 15_000);
    }
};

const coerceId = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const findIdsDeep = (data: unknown): IdPair => {
    if (!data || typeof data !== "object") {
        return { anilistID: null, malID: null };
    }

    if (Array.isArray(data)) {
        for (const item of data) {
            const ids = findIdsDeep(item);
            if (ids.anilistID !== null || ids.malID !== null) {
                return ids;
            }
        }
        return { anilistID: null, malID: null };
    }

    const obj = data as Record<string, unknown>;
    const anilistID =
        coerceId(obj.anilistID) ?? coerceId(obj.anilistId) ?? null;
    const malID = coerceId(obj.malID) ?? coerceId(obj.malId) ?? null;

    if (anilistID !== null || malID !== null) {
        return { anilistID, malID };
    }

    for (const value of Object.values(obj)) {
        const ids = findIdsDeep(value);
        if (ids.anilistID !== null || ids.malID !== null) {
            return ids;
        }
    }

    return { anilistID: null, malID: null };
};

const isAnimeSlug = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    if (value.length < 3) return false;
    if (value.includes("?ep=")) return false;
    if (value.includes("/")) return false;
    return /[a-z]/i.test(value) && value.includes("-");
};

const isAnimeLikeObject = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;

    const hasAnimeSignals =
        typeof obj.type === "string" ||
        typeof obj.duration === "string" ||
        typeof obj.rank === "number" ||
        typeof obj.episodes === "object" ||
        typeof obj.jname === "string";

    const hasCharacterSignals =
        "voiceActors" in obj ||
        "voiceActor" in obj ||
        "role" in obj ||
        "character" in obj;

    return (
        isAnimeSlug(obj.id) &&
        hasAnimeSignals &&
        !hasCharacterSignals &&
        (typeof obj.name === "string" ||
            typeof obj.jname === "string" ||
            typeof obj.poster === "string")
    );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientMetaUpstreamError = (message: string) =>
    /service unavailable|fetcherror|timed out|timeout|503/i.test(message);

const withTimeout = async <T>(
    promise: Promise<T>,
    ms: number,
    label: string
): Promise<T> => {
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });

    return Promise.race([promise, timeoutPromise]);
};

const getAnimeInfoReliable = async (animeId: string) => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= HIANIME_INFO_RETRY_COUNT; attempt++) {
        try {
            return await withTimeout(
                hianime.getInfo(animeId),
                HIANIME_INFO_TIMEOUT_MS,
                `hianime.getInfo(${animeId})`
            );
        } catch (err) {
            lastError = err;
            if (attempt >= HIANIME_INFO_RETRY_COUNT) break;
            const backoff = 250 * Math.pow(2, attempt);
            await sleep(backoff);
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to fetch anime info for ${animeId}`);
};

const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
) => {
    const safeConcurrency = Math.max(1, Math.min(concurrency, 16));
    const results = new Array<R>(items.length);
    let cursor = 0;

    const worker = async () => {
        while (true) {
            const current = cursor;
            cursor += 1;
            if (current >= items.length) break;
            results[current] = await mapper(items[current], current);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker())
    );

    return results;
};

const collectAnimeIds = (value: unknown, out: Set<string>, skipKey?: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        for (const item of value) collectAnimeIds(item, out, skipKey);
        return;
    }

    const obj = value as Record<string, unknown>;
    if (isAnimeLikeObject(obj)) {
        out.add(obj.id as string);
    }

    for (const [key, child] of Object.entries(obj)) {
        if (key === skipKey) continue;
        collectAnimeIds(child, out, skipKey);
    }
};

const resolveAnimeMeta = async (animeId: string): Promise<AnimeMeta> => {
    const cached = getTimedCacheValue(animeMetaLookupCache, animeId);
    if (cached) return cached;

    if (Date.now() < metaUpstreamDegradedUntil) {
        const meta: AnimeMeta = { anilistID: null, malID: null, poster: null, banner: null };
        setTimedCacheValue(animeMetaLookupCache, animeId, meta, 5 * 60 * 1000);
        return meta;
    }

    const inflight = animeMetaLookupInflight.get(animeId);
    if (inflight) return inflight;

    const promise = (async () => {
        try {
            const info = await cache.getOrSet(
                async () => getAnimeInfoReliable(animeId),
                `meta:anime-info:${animeId}`,
                60 * 60,
                {
                    staleWhileRevalidateSeconds: 6 * 60 * 60,
                    allowStaleOnError: true,
                }
            );
            const meta: AnimeMeta = {
                anilistID: info?.anime?.info?.anilistId ?? null,
                malID: info?.anime?.info?.malId ?? null,
                poster: null,
                banner: null,
            };
            metaUpstreamFailureStreak = 0;
            metaUpstreamDegradedUntil = 0;
            setTimedCacheValue(animeMetaLookupCache, animeId, meta, META_LOOKUP_TTL_MS);
            return meta;
        } catch (err) {
            const message = (err as Error).message || "unknown error";
            if (!/not found/i.test(message)) {
                if (isTransientMetaUpstreamError(message)) {
                    metaUpstreamFailureStreak += 1;
                    if (metaUpstreamFailureStreak >= META_UPSTREAM_FAILURE_THRESHOLD) {
                        metaUpstreamDegradedUntil = Date.now() + META_UPSTREAM_DEGRADED_TTL_MS;
                        logRateLimited(
                            "meta-upstream-degraded",
                            () => {
                                log.warn(
                                    {
                                        until: new Date(metaUpstreamDegradedUntil).toISOString(),
                                        failureStreak: metaUpstreamFailureStreak,
                                    },
                                    "anime meta upstream degraded; temporarily serving cached fallback"
                                );
                            },
                            15000
                        );
                    }
                    logRateLimited(
                        "meta-upstream-transient",
                        () => log.warn({ animeId, message }, "failed to resolve anime meta (rate-limited)"),
                        15000
                    );
                } else {
                    logRateLimited(
                        `meta-resolve:${animeId}`,
                        () => log.warn({ animeId, message }, "failed to resolve anime meta"),
                        30000
                    );
                }
            }
            const meta: AnimeMeta = { anilistID: null, malID: null, poster: null, banner: null };
            setTimedCacheValue(animeMetaLookupCache, animeId, meta, 30 * 60 * 1000);
            return meta;
        } finally {
            animeMetaLookupInflight.delete(animeId);
        }
    })();

    animeMetaLookupInflight.set(animeId, promise);
    return promise;
};

const resolveAnilistPoster = async (
    ids: IdPair
): Promise<{ poster: string | null; banner: string | null } | null> => {
    const validAniListId = ids.anilistID && ids.anilistID > 0 ? ids.anilistID : null;
    const validMalId = ids.malID && ids.malID > 0 ? ids.malID : null;
    if (!validAniListId && !validMalId) return null;

    const cacheKey = validAniListId
        ? `anilist:${validAniListId}`
        : `mal:${validMalId}`;

    const cached = getTimedCacheValue(anilistPosterLookupCache, cacheKey);
    if (cached !== undefined) return cached;

    const inflight = anilistPosterLookupInflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
        try {
            const query = validAniListId
                ? `query ($id: Int) { Media(id: $id, type: ANIME) { bannerImage coverImage { extraLarge large medium } } }`
                : `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { bannerImage coverImage { extraLarge large medium } } }`;
            const resp = await fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    query,
                    variables: validAniListId
                        ? { id: validAniListId }
                        : { idMal: validMalId },
                }),
            });

            if (!resp.ok) {
                setTimedCacheValue(anilistPosterLookupCache, cacheKey, null, 30 * 60 * 1000);
                return null;
            }

            const json = (await resp.json()) as any;

            const poster =
                json?.data?.Media?.coverImage?.extraLarge ||
                json?.data?.Media?.coverImage?.large ||
                json?.data?.Media?.coverImage?.medium ||
                null;

            const banner = json?.data?.Media?.bannerImage || null;

            const result = { poster, banner };
            setTimedCacheValue(anilistPosterLookupCache, cacheKey, result, POSTER_LOOKUP_TTL_MS);
            return result;
        } catch {
            setTimedCacheValue(anilistPosterLookupCache, cacheKey, null, 30 * 60 * 1000);
            return null;
        } finally {
            anilistPosterLookupInflight.delete(cacheKey);
        }
    })();

    anilistPosterLookupInflight.set(cacheKey, promise);
    return promise;
};

const resolveExternalAnimeId = async (inputAnimeId: string): Promise<string> => {
    let animeId = inputAnimeId.trim();
    if (!(animeId.startsWith("mal-") || animeId.startsWith("anilist-"))) {
        return animeId;
    }

    const isMal = animeId.startsWith("mal-");
    const externalId = parseInt(animeId.replace(/^(mal-|anilist-)/, ""));
    if (isNaN(externalId)) return animeId;

    try {
        const titleQuery = isMal
            ? `query ($id: Int) { Media(idMal: $id, type: ANIME) { title { english romaji native } } }`
            : `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji native } } }`;

        const aniResp = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: titleQuery, variables: { id: externalId } }),
        });

        if (!aniResp.ok) return animeId;

        const aniJson = (await aniResp.json()) as any;
        const title =
            aniJson?.data?.Media?.title?.english ||
            aniJson?.data?.Media?.title?.romaji ||
            aniJson?.data?.Media?.title?.native;

        if (!title) return animeId;

        const searchResults = await hianime.search(title);
        const foundId = searchResults.animes?.[0]?.id;
        if (foundId) {
            return foundId;
        }
    } catch (err) {
        log.warn({ animeId, err }, "failed to resolve external anime mapping");
    }

    return animeId;
};

const addIdsToAnimeObjects = (
    value: unknown,
    lookup: Map<string, AnimeMeta>,
    skipPoster = false
): unknown => {
    if (!value || typeof value !== "object") return value;

    if (Array.isArray(value)) {
        return value.map((item) => addIdsToAnimeObjects(item, lookup, skipPoster));
    }

    const obj = value as Record<string, unknown>;
    const transformed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
        // Special case for spotlightAnimes array: skip poster override for its children
        const shouldSkipPoster = skipPoster || key === "spotlightAnimes";
        transformed[key] = addIdsToAnimeObjects(child, lookup, shouldSkipPoster);
    }

    if (isAnimeLikeObject(obj)) {
        const animeId = obj.id as string;
        const resolved = lookup.get(animeId) || {
            anilistID: null,
            malID: null,
            poster: null,
            banner: null,
        };
        transformed.anilistID =
            coerceId(obj.anilistID) ??
            coerceId(obj.anilistId) ??
            resolved.anilistID;
        transformed.malID =
            coerceId(obj.malID) ?? coerceId(obj.malId) ?? resolved.malID;
        transformed.anilist_id =
            coerceId(obj.anilist_id) ??
            coerceId(obj.anilistId) ??
            resolved.anilistID;
        transformed.mal_id =
            coerceId(obj.mal_id) ?? coerceId(obj.malId) ?? resolved.malID;

        if (!skipPoster) {
            if (resolved.poster) {
                transformed.poster = resolved.poster;
            }
            if (resolved.banner) {
                transformed.banner = resolved.banner;
            }
        }
    }

    return transformed;
};

const enrichAnimeObjectsWithIds = async <T>(data: T): Promise<T> => {
    const ids = new Set<string>();
    collectAnimeIds(data, ids);

    if (ids.size === 0) return data;

    const lookup = new Map<string, AnimeMeta>();
    await mapWithConcurrency(
        Array.from(ids),
        META_RESOLVE_CONCURRENCY,
        async (animeId) => {
            const resolvedMeta = await resolveAnimeMeta(animeId);
            const extra = await resolveAnilistPoster(resolvedMeta);

            lookup.set(animeId, {
                ...resolvedMeta,
                poster: extra?.poster ?? resolvedMeta.poster,
                banner: extra?.banner ?? resolvedMeta.banner,
            });
        }
    );

    return addIdsToAnimeObjects(data, lookup) as T;
};

const attachIdsToPayload = <T>(data: T, ids: IdPair): T => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return data;
    }
    const obj = data as Record<string, unknown>;
    return {
        ...obj,
        anilistID: coerceId(obj.anilistID) ?? ids.anilistID,
        malID: coerceId(obj.malID) ?? ids.malID,
        anilist_id: coerceId(obj.anilist_id) ?? ids.anilistID,
        mal_id: coerceId(obj.mal_id) ?? ids.malID,
    } as T;
};

const ok = async <T>(data: T) => {
    if (isVerboseLoggingEnabled) {
        log.debug("processing response in ok() helper");
    }
    try {
        const enrichedData = await enrichAnimeObjectsWithIds(data);
        const ids = findIdsDeep(enrichedData);
        return {
            status: 200,
            anilistID: ids.anilistID,
            malID: ids.malID,
            anilist_id: ids.anilistID,
            mal_id: ids.malID,
            data: attachIdsToPayload(enrichedData, ids),
        };
    } catch (err) {
        log.error({ err }, "ok() helper failed");
        throw err;
    }
};

const normalizeServerName = (name: string) => {
    const serverName = name.trim().toLowerCase();
    switch (serverName) {
        case "megacloud":
        case "rapidcloud":
        case "hd-1":
            return "HD-1";
        case "vidsrc":
        case "vidstreaming":
        case "hd-2":
            return "HD-2";
        case "t-cloud":
        case "hd-3":
            return "HD-3";
        default:
            return name;
    }
};

const BLOCKED_HIANIME_HOST_MARKERS = ["douvid.xyz", "haildrop77.pro", "fxpy7.watching.onl"];

const includesBlockedHianimeHost = (value: unknown): boolean => {
    const normalized = String(value || "").toLowerCase();
    if (!normalized) return false;
    return BLOCKED_HIANIME_HOST_MARKERS.some((marker) => normalized.includes(marker));
};

const filterBlockedServerEntries = <T extends { serverName?: string | null }>(
    entries: T[]
) => entries.filter((entry) => !includesBlockedHianimeHost(entry.serverName));

const filterBlockedStreamLinks = <T extends {
    link?: string | null;
    url?: string | null;
    file?: string | null;
    iframe?: string | null;
}>(entries: T[]) =>
    entries.filter((entry) => {
        const sourceUrl = entry.link ?? entry.url ?? entry.file ?? "";
        return (
            !includesBlockedHianimeHost(sourceUrl) &&
            !includesBlockedHianimeHost(entry.iframe)
        );
    });

// /api/v2/hianime
tatakaiRouter.get("/", (c) => c.redirect("/", 301));

// Explicit Aliases for backward compatibility
tatakaiRouter.get("/stream", async (c) => {
    const query = c.req.query();
    const animeEpisodeId = decodeURIComponent(query.id || query.animeEpisodeId || "");
    const server = decodeURIComponent(query.server || "HD-1") as AniwatchTypes.AnimeServers;
    const category = decodeURIComponent(query.type || query.category || "sub") as "sub" | "dub" | "raw";

    const [sourcesRaw, serversRaw] = await Promise.all([
        hianime.getEpisodeSources(animeEpisodeId, server, category),
        hianime.getEpisodeServers(animeEpisodeId),
    ]);

    const sources = sourcesRaw as any;
    const servers = serversRaw as any;

    const mergedServers = filterBlockedServerEntries([
        ...(servers.sub || []).map((item: any) => ({
            type: "sub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...(servers.dub || []).map((item: any) => ({
            type: "dub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...(servers.raw || []).map((item: any) => ({
            type: "raw",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
    ]);

    const availableSources = filterBlockedStreamLinks(
        Array.isArray(sources.sources)
            ? sources.sources.map((source: any) => ({
                  url: source?.url || "",
                  type: source?.type || "hls",
              }))
            : []
    ) as Array<{ url: string; type: string }>;
    const primarySource = availableSources[0];
    const iframe = includesBlockedHianimeHost(sources.embedURL)
        ? ""
        : sources.embedURL || "";

    const response = {
        streamingLink: [
            {
                link: primarySource?.url || "",
                type: primarySource?.type || "hls",
                server: normalizeServerName(server),
                iframe,
            },
        ],
        tracks: sources.tracks || [],
        subtitles: sources.subtitles || [],
        intro: sources.intro || null,
        outro: sources.outro || null,
        server: normalizeServerName(server),
        servers: mergedServers,
        anilistID: sources.anilistID ?? null,
        malID: sources.malID ?? null,
    };

    return c.json({ success: true, results: response }, 200);
});

tatakaiRouter.get("/servers/:episodeId", async (c) => {
    const animeEpisodeId = decodeURIComponent(c.req.param("episodeId") || "");
    const serversRaw = await hianime.getEpisodeServers(animeEpisodeId);
    const servers = serversRaw as any;

    const mergedServers = filterBlockedServerEntries([
        ...(servers.sub || []).map((item: any) => ({
            type: "sub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...(servers.dub || []).map((item: any) => ({
            type: "dub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...(servers.raw || []).map((item: any) => ({
            type: "raw",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
    ]);

    return c.json({ success: true, results: mergedServers }, 200);
});

// /api/v2/hianime/home
tatakaiRouter.get("/home", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const data = await cache.getOrSet<AniwatchTypes.ScrapedHomePage>(
        hianime.getHomePage,
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/azlist/{sortOption}?page={page}
tatakaiRouter.get("/azlist/:sortOption", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const sortOption = decodeURIComponent(
        c.req.param("sortOption").trim().toLowerCase()
    ) as AZListSortOptions;
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeAZList>(
        async () => hianime.getAZList(sortOption, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/qtip/{animeId}
tatakaiRouter.get("/qtip/:animeId", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const animeId = decodeURIComponent(c.req.param("animeId").trim());

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeQtipInfo>(
        async () => hianime.getQtipInfo(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/category/{name}?page={page}
tatakaiRouter.get("/category/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const categoryName = decodeURIComponent(
        c.req.param("name").trim()
    ) as AniwatchTypes.AnimeCategories;
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeCategory>(
        async () => hianime.getCategoryAnime(categoryName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/genre/{name}?page={page}
tatakaiRouter.get("/genre/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const genreName = decodeURIComponent(c.req.param("name").trim());
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedGenreAnime>(
        async () => hianime.getGenreAnime(genreName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/producer/{name}?page={page}
tatakaiRouter.get("/producer/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const producerName = decodeURIComponent(c.req.param("name").trim());
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedProducerAnime>(
        async () => hianime.getProducerAnimes(producerName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/schedule?date={date}&tzOffset={tzOffset}
tatakaiRouter.get("/schedule", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const date = decodeURIComponent(c.req.query("date") || "");
    let tzOffset = Number(
        decodeURIComponent(c.req.query("tzOffset") || "-330")
    );
    tzOffset = isNaN(tzOffset) ? -330 : tzOffset;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedEstimatedSchedule>(
        async () => hianime.getEstimatedSchedule(date, tzOffset),
        `${cacheConfig.key}_${tzOffset}`,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/search?q={query}&page={page}&filters={...filters}
tatakaiRouter.get("/search", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let { q: query, page, ...filters } = c.req.query();

    query = decodeURIComponent(query || "");
    const pageNo = Number(decodeURIComponent(page || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeSearchResult>(
        async () => hianime.search(query, pageNo, filters),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/search/suggestion?q={query}
tatakaiRouter.get("/search/suggestion", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const query = decodeURIComponent(c.req.query("q") || "");

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeSearchSuggestion>(
        async () => hianime.searchSuggestions(query),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/anime/{animeId}
tatakaiRouter.get("/anime/:animeId", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());

    if (isVerboseLoggingEnabled) {
        log.debug({ animeId }, "anime route received");
    }
    animeId = await resolveExternalAnimeId(animeId);

    try {
        const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeAboutInfo>(
            async () => {
                if (isVerboseLoggingEnabled) {
                    log.debug({ animeId }, "fetching anime info from hianime");
                }
                return getAnimeInfoReliable(animeId);
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        if (isVerboseLoggingEnabled) {
            log.debug({ animeId }, "anime info fetched successfully");
        }
        
        // Enrich with AniList poster
        let enrichedData = data;
        try {
            const anilistId = coerceId(data?.anime?.info?.anilistId ?? data?.anime?.moreInfo?.anilistId);
            const malId = coerceId(data?.anime?.info?.malId ?? data?.anime?.moreInfo?.malId);
            
            if (anilistId || malId) {
                const posterData = await resolveAnilistPoster({ anilistID: anilistId, malID: malId });
                if (posterData?.poster && enrichedData?.anime?.info) {
                    enrichedData = {
                        ...enrichedData,
                        anime: {
                            ...enrichedData.anime,
                            info: {
                                ...enrichedData.anime.info,
                                poster: posterData.poster // Use AniList poster
                            }
                        }
                    };
                }
            }
        } catch (posterErr) {
            log.warn({ animeId, err: posterErr }, "failed to fetch AniList poster");
            // Fallback to original data if poster fetch fails
        }
        
        const result = await ok(enrichedData);
        return c.json(result, { status: 200 });
    } catch (err) {
        log.error({ animeId, err }, "failed to handle anime route");
        const safeError = {
            error: (err as Error).message,
            stack: isVerboseLoggingEnabled ? (err as Error).stack : undefined,
        };
        return c.json(safeError, { status: 500 });
    }
});

// /api/v2/hianime/episode/servers?animeEpisodeId={id}
// ALIAS: /api/v2/hianime/servers
tatakaiRouter.get("/episode/servers", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );

    const canonicalKey = buildEpisodeServersCanonicalKey(animeEpisodeId);
    const canonicalCached = await readEpisodeCanonicalSnapshot<any[]>(
        canonicalKey,
        EPISODE_SOURCE_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
        return c.json(await ok(canonicalCached), { status: 200 });
    }

    const data = await cache.getOrSet<any>(
        async () => {
            const serversRaw = await hianime.getEpisodeServers(animeEpisodeId);
            const servers = serversRaw as any;
            return filterBlockedServerEntries([
                ...(servers.sub || []).map((item: any) => ({
                    type: "sub",
                    data_id: item.dataId || null,
                    server_id: item.serverId,
                    serverName: normalizeServerName(item.serverName),
                })),
                ...(servers.dub || []).map((item: any) => ({
                    type: "dub",
                    data_id: item.dataId || null,
                    server_id: item.serverId,
                    serverName: normalizeServerName(item.serverName),
                })),
                ...(servers.raw || []).map((item: any) => ({
                    type: "raw",
                    data_id: item.dataId || null,
                    server_id: item.serverId,
                    serverName: normalizeServerName(item.serverName),
                })),
            ]);
        },
        cacheConfig.key,
        cacheConfig.duration
    );

    if (Array.isArray(data) && data.length > 0) {
        await writeEpisodeCanonicalSnapshot({
            key: canonicalKey,
            routePath: "/internal/hianime/episode/servers",
            queryString: `animeEpisodeId=${encodeURIComponent(animeEpisodeId)}`,
            payload: data,
            projection: {
                animeEpisodeId,
                serverCount: data.length,
            },
            ttlSeconds: cacheConfig.duration,
        });
    }

    return c.json(await ok(data), { status: 200 });
});

// episodeId=steinsgate-3?ep=230
// /api/v2/hianime/episode/sources?animeEpisodeId={episodeId}?server={server}&category={category (dub or sub)}
tatakaiRouter.get("/episode/sources", async (c) => {
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );
    const server = decodeURIComponent(
        c.req.query("server") || HiAnime.Servers.VidStreaming
    ) as AniwatchTypes.AnimeServers;
    const category = decodeURIComponent(c.req.query("category") || "sub") as
        | "sub"
        | "dub"
        | "raw";

    const canonicalKey = buildEpisodeCanonicalKey(
        "sources",
        animeEpisodeId,
        server,
        category
    );

    const canonicalCached = await readEpisodeCanonicalSnapshot<AniwatchTypes.ScrapedAnimeEpisodesSources>(
        canonicalKey,
        EPISODE_SOURCE_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
        return c.json(await ok(canonicalCached), { status: 200 });
    }

    const data = await (async () => {
        try {
            const streamInfo = await extractCompatStreamingInfo(animeEpisodeId, server, category);

            // Map hianime-api results to AniwatchTypes format expected by frontend
            const allowedStreamingLinks = filterBlockedStreamLinks(
                Array.isArray(streamInfo.streamingLink)
                    ? streamInfo.streamingLink.map((s: any) => ({
                          link: s?.link || "",
                          type: s?.type || "hls",
                          iframe: s?.iframe || "",
                      }))
                    : []
            ) as Array<{ link: string; type: string }>;

            return {
                sources: allowedStreamingLinks.map((s) => ({
                    url: s.link,
                    type: s.type || "hls",
                    isM3U8: String(s.link).includes(".m3u8"),
                })),
                subtitles: streamInfo.tracks?.map((t: any) => ({
                    url: t.file,
                    lang: t.label,
                    label: t.label,
                    default: t.default || false
                })) || [],
                intro: streamInfo.intro,
                outro: streamInfo.outro,
                server: streamInfo.server,
                availableServers: filterBlockedServerEntries(
                    Array.isArray(streamInfo.servers) ? streamInfo.servers : []
                ),
            } as AniwatchTypes.ScrapedAnimeEpisodesSources;
        } catch (err) {
            log.error({ err }, "stream proxy extraction failed");
            return { sources: [], subtitles: [] } as any;
        }
    })();

    if ((data.sources || []).length > 0 || (data.subtitles || []).length > 0) {
        await writeEpisodeCanonicalSnapshot({
            key: canonicalKey,
            routePath: "/internal/hianime/episode/sources",
            queryString: `animeEpisodeId=${encodeURIComponent(animeEpisodeId)}&server=${encodeURIComponent(server)}&category=${encodeURIComponent(category)}`,
            payload: data,
            projection: {
                animeEpisodeId,
                server,
                category,
                sourceCount: (data.sources || []).length,
                subtitleCount: (data.subtitles || []).length,
            },
            ttlSeconds: 600,
        });
    }

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/episode/stream?animeEpisodeId={episodeId}&server={server}&category={category}
// ALIAS: /api/v2/hianime/stream
tatakaiRouter.get("/episode/stream", async (c) => {
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );
    const server = decodeURIComponent(
        c.req.query("server") || HiAnime.Servers.VidStreaming
    ) as AniwatchTypes.AnimeServers;
    const category = decodeURIComponent(c.req.query("category") || "sub") as
        | "sub"
        | "dub"
        | "raw";

    const canonicalKey = buildEpisodeCanonicalKey(
        "stream",
        animeEpisodeId,
        server,
        category
    );

    const canonicalCached = await readEpisodeCanonicalSnapshot<any>(
        canonicalKey,
        EPISODE_SOURCE_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
        return c.json(await ok(canonicalCached), { status: 200 });
    }

    const [sourcesRaw, serversRaw] = await Promise.all([
        hianime.getEpisodeSources(animeEpisodeId, server, category),
        hianime.getEpisodeServers(animeEpisodeId),
    ]);

    const sources = sourcesRaw as AniwatchTypes.ScrapedAnimeEpisodesSources & {
        tracks?: Array<{
            file: string;
            kind?: string;
            label?: string;
            default?: boolean;
        }>;
        outro?: { start: number; end: number };
    };
    const servers = serversRaw as {
        sub: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
        dub: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
        raw: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
    };

    const mergedServers = filterBlockedServerEntries([
        ...servers.sub.map((item) => ({
            type: "sub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...servers.dub.map((item) => ({
            type: "dub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...servers.raw.map((item) => ({
            type: "raw",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
    ]);

    const availableSources = filterBlockedStreamLinks(
        Array.isArray(sources.sources)
            ? sources.sources.map((source) => ({
                  url: source?.url || "",
                  type: source?.type || "hls",
              }))
            : []
    ) as Array<{ url: string; type: string }>;
    const primarySource = availableSources[0];
    const iframe = includesBlockedHianimeHost(sources.embedURL)
        ? ""
        : sources.embedURL || "";

    const response = {
        streamingLink: [
            {
                link: primarySource?.url || "",
                type: primarySource?.type || "hls",
                server: normalizeServerName(server),
                iframe,
            },
        ],
        tracks: sources.tracks || [],
        subtitles: sources.subtitles || [],
        intro: sources.intro || null,
        outro: sources.outro || null,
        server: normalizeServerName(server),
        servers: mergedServers,
        anilistID: sources.anilistID ?? null,
        malID: sources.malID ?? null,
    };

    if ((response.streamingLink || []).some((item) => String(item.link || "").trim().length > 0)) {
        await writeEpisodeCanonicalSnapshot({
            key: canonicalKey,
            routePath: "/internal/hianime/episode/stream",
            queryString: `animeEpisodeId=${encodeURIComponent(animeEpisodeId)}&server=${encodeURIComponent(server)}&category=${encodeURIComponent(category)}`,
            payload: response,
            projection: {
                animeEpisodeId,
                server,
                category,
                streamingLinkCount: (response.streamingLink || []).length,
                subtitleCount: (response.subtitles || []).length,
                trackCount: (response.tracks || []).length,
            },
            ttlSeconds: 600,
        });
    }

    return c.json(await ok(response), { status: 200 });
});

// /api/v2/hianime/anime/{anime-id}/episodes
tatakaiRouter.get("/anime/:animeId/episodes", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());
    animeId = await resolveExternalAnimeId(animeId);

    const canonicalKey = buildAnimeEpisodesCanonicalKey(animeId);
    const canonicalCached = await readEpisodeCanonicalSnapshot<AniwatchTypes.ScrapedAnimeEpisodes>(
        canonicalKey,
        EPISODE_SOURCE_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
        return c.json(await ok(canonicalCached), { status: 200 });
    }

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeEpisodes>(
        async () => hianime.getEpisodes(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    const episodesCount = Array.isArray((data as any)?.episodes)
        ? (data as any).episodes.length
        : Array.isArray(data)
            ? data.length
            : 0;

    await writeEpisodeCanonicalSnapshot({
        key: canonicalKey,
        routePath: "/internal/hianime/anime/episodes",
        queryString: `animeId=${encodeURIComponent(animeId)}`,
        payload: data,
        projection: {
            animeId,
            episodesCount,
        },
        ttlSeconds: cacheConfig.duration,
    });

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/anime/{anime-id}/next-episode-schedule
tatakaiRouter.get("/anime/:animeId/next-episode-schedule", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());
    animeId = await resolveExternalAnimeId(animeId);

    const canonicalKey = buildNextEpisodeScheduleCanonicalKey(animeId);
    const canonicalCached = await readEpisodeCanonicalSnapshot<AniwatchTypes.ScrapedNextEpisodeSchedule>(
        canonicalKey,
        EPISODE_SOURCE_CANONICAL_FRESH_MS
    );
    if (canonicalCached) {
        return c.json(await ok(canonicalCached), { status: 200 });
    }

    const data = await cache.getOrSet<AniwatchTypes.ScrapedNextEpisodeSchedule>(
        async () => hianime.getNextEpisodeSchedule(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    await writeEpisodeCanonicalSnapshot({
        key: canonicalKey,
        routePath: "/internal/hianime/anime/next-episode-schedule",
        queryString: `animeId=${encodeURIComponent(animeId)}`,
        payload: data,
        projection: {
            animeId,
        },
        ttlSeconds: cacheConfig.duration,
    });

    return c.json(await ok(data), { status: 200 });
});

export { tatakaiRouter };
