import type { MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { canonicalStore, type SourceValidationCandidate } from "../lib/canonicalStore.js";
import { log, logRateLimited } from "../config/logger.js";

type SnapshotScope = "anime" | "manga" | "hianime";

type ProviderSnapshotProjection = {
  anilistId: unknown;
  malId: unknown;
  bannerImage: unknown;
  sources: unknown[];
  subtitles: unknown[];
  providers: unknown[];
  chapters: unknown[];
  pages: unknown[];
  images: unknown[];
};

type ProviderSnapshotEnvelope = {
  version: 1;
  scope: SnapshotScope;
  key: string;
  savedAt: string;
  status: number;
  request: {
    pathname: string;
    search: string;
    url: string;
  };
  projection: ProviderSnapshotProjection;
  data: unknown;
};

const SNAPSHOT_ROOT_DIR = nodePath.join(process.cwd(), "fallback", "provider-json");
const JSON_CONTENT_TYPE = "application/json";
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const CANONICAL_WRITE_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(Number.parseInt(String(process.env.TATAKAI_CANONICAL_WRITE_MAX_CONCURRENCY || "2"), 10) || 2, 8)
);
const CANONICAL_WRITE_MAX_QUEUE = Math.max(
  50,
  Math.min(Number.parseInt(String(process.env.TATAKAI_CANONICAL_WRITE_MAX_QUEUE || "500"), 10) || 500, 5000)
);
const SNAPSHOT_CONTROL_QUERY_KEYS = new Set([
  "snapshot",
  "snapshotRefresh",
  "snapshotUse",
  "snapshotWrite",
  "snapshotSource",
  "snapshotFallback",
  "snapshotPurge",
]);

type QueuedCanonicalWrite = {
  key: string;
  scope: SnapshotScope;
  run: () => Promise<void>;
};

const canonicalWriteQueue: QueuedCanonicalWrite[] = [];
const canonicalWriteInFlightKeys = new Set<string>();
const canonicalWriteQueuedKeys = new Set<string>();
let canonicalWriteInFlight = 0;

const pumpCanonicalWriteQueue = () => {
  while (canonicalWriteInFlight < CANONICAL_WRITE_MAX_CONCURRENCY && canonicalWriteQueue.length > 0) {
    const nextTask = canonicalWriteQueue.shift();
    if (!nextTask) break;

    canonicalWriteQueuedKeys.delete(nextTask.key);
    canonicalWriteInFlightKeys.add(nextTask.key);
    canonicalWriteInFlight += 1;

    void Promise.resolve()
      .then(() => nextTask.run())
      .catch((error: any) => {
        logRateLimited(`provider-snapshot:db-queue:${nextTask.scope}`, () => {
          log.warn(
            { error: error?.message || String(error), scope: nextTask.scope, key: nextTask.key },
            "canonical snapshot async write task failed"
          );
        }, 15_000);
      })
      .finally(() => {
        canonicalWriteInFlight = Math.max(0, canonicalWriteInFlight - 1);
        canonicalWriteInFlightKeys.delete(nextTask.key);
        pumpCanonicalWriteQueue();
      });
  }
};

const enqueueCanonicalWrite = (task: QueuedCanonicalWrite) => {
  if (canonicalWriteQueuedKeys.has(task.key) || canonicalWriteInFlightKeys.has(task.key)) {
    return;
  }

  const totalPending = canonicalWriteInFlight + canonicalWriteQueue.length;
  if (totalPending >= CANONICAL_WRITE_MAX_QUEUE) {
    logRateLimited(`provider-snapshot:db-queue-full:${task.scope}`, () => {
      log.warn(
        { scope: task.scope, key: task.key, totalPending, maxQueue: CANONICAL_WRITE_MAX_QUEUE },
        "canonical snapshot queue full; dropping async write"
      );
    }, 15_000);
    return;
  }

  canonicalWriteQueuedKeys.add(task.key);
  canonicalWriteQueue.push(task);
  pumpCanonicalWriteQueue();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

const pickFirst = (values: unknown[]) => values.find((value) => value !== undefined && value !== null);

const toNullableInt = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const sanitizeSegment = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "segment";

const buildSnapshotSearch = (requestUrl: URL) => {
  const params = new URLSearchParams(requestUrl.searchParams);
  for (const key of SNAPSHOT_CONTROL_QUERY_KEYS) {
    params.delete(key);
  }

  // Normalize query key order so equivalent requests map to one snapshot key.
  const normalizedParams = new URLSearchParams();
  const sortedEntries = [...params.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of sortedEntries) {
    normalizedParams.append(key, value);
  }

  const normalized = normalizedParams.toString();
  return normalized ? `?${normalized}` : "";
};

const buildSnapshotKey = (scope: SnapshotScope, requestUrl: URL) =>
  `${scope}:${requestUrl.pathname}${buildSnapshotSearch(requestUrl)}`;

const resolveRouteBase = (scope: SnapshotScope) => {
  if (scope === "hianime") return "/api/v2/hianime/";
  return `/api/v2/${scope}/`;
};

const resolveProviderFromPath = (scope: SnapshotScope, pathname: string) => {
  const base = resolveRouteBase(scope).replace(/\/+$/g, "");
  if (!pathname.startsWith(base)) return null;

  const tail = pathname.slice(base.length).replace(/^\/+/, "");
  const segments = tail.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  if (scope === "anime" && segments[0] === "mapper" && segments[1]) {
    return `mapper:${segments[1].toLowerCase()}`;
  }

  if (scope === "hianime") return "hianime";

  return segments[0].toLowerCase();
};

const toResponseHeaderRecord = (headers: Headers) => {
  const out: Record<string, unknown> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const extractObjectUrl = (value: Record<string, unknown>) => {
  const candidates = [
    value.url,
    value.link,
    value.file,
    value.src,
    value.img,
    value.image,
    value.directUrl,
    value.proxiedUrl,
    value.thumbnail,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    if (/^https?:\/\//i.test(text)) return text;
  }

  return null;
};

const collectUrls = (values: unknown[]) => {
  const unique = new Set<string>();

  for (const value of values) {
    if (typeof value === "string") {
      const text = value.trim();
      if (/^https?:\/\//i.test(text)) unique.add(text);
      continue;
    }

    if (isRecord(value)) {
      const picked = extractObjectUrl(value);
      if (picked) unique.add(picked);
    }
  }

  return [...unique];
};

const deriveImageEntriesFromPages = (pages: unknown[]) => {
  const imageUrls = collectUrls(pages);
  return imageUrls.map((url) => ({ url }));
};

const buildSnapshotPath = (scope: SnapshotScope, requestUrl: URL, key: string) => {
  const normalizedBase = resolveRouteBase(scope);
  const relativePath = requestUrl.pathname.startsWith(normalizedBase)
    ? requestUrl.pathname.slice(normalizedBase.length)
    : requestUrl.pathname.replace(/^\/+/g, "");

  const rawSegments = relativePath.split("/").filter(Boolean);
  const safeSegments = rawSegments.map(sanitizeSegment);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 14);
  const fileName = `${(safeSegments.pop() || "index")}-${hash}.json`;

  const filePath = nodePath.join(SNAPSHOT_ROOT_DIR, scope, ...safeSegments, fileName);
  return filePath;
};

const shouldHandleRequest = (scope: SnapshotScope, requestUrl: URL, method: string) => {
  if (method !== "GET") return false;
  if (requestUrl.searchParams.get("snapshot") === "0") return false;
  if (!requestUrl.pathname.startsWith(resolveRouteBase(scope).slice(0, -1))) return false;

  const pathname = requestUrl.pathname.toLowerCase();
  if (
    pathname.includes("/health") ||
    pathname.includes("/docs") ||
    pathname.includes("/webhooks") ||
    pathname.includes("/jobs/")
  ) {
    return false;
  }

  return true;
};

const parseJsonResponse = async (response: Response) => {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes(JSON_CONTENT_TYPE)) return null;

  const text = await response.clone().text();
  if (!text.trim()) return null;
  if (Buffer.byteLength(text, "utf-8") > MAX_SNAPSHOT_BYTES) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const readSnapshot = async (filePath: string): Promise<ProviderSnapshotEnvelope | null> => {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProviderSnapshotEnvelope>;
    if (!isRecord(parsed)) return null;
    if (!("data" in parsed)) return null;

    return {
      version: 1,
      scope: (parsed.scope === "manga" || parsed.scope === "hianime" ? parsed.scope : "anime") as SnapshotScope,
      key: String(parsed.key || ""),
      savedAt: String(parsed.savedAt || ""),
      status: Number(parsed.status || 200),
      request: {
        pathname: String(parsed.request?.pathname || ""),
        search: String(parsed.request?.search || ""),
        url: String(parsed.request?.url || ""),
      },
      projection: {
        anilistId: parsed.projection?.anilistId,
        malId: parsed.projection?.malId,
        bannerImage: parsed.projection?.bannerImage,
        sources: Array.isArray(parsed.projection?.sources) ? parsed.projection!.sources : [],
        subtitles: Array.isArray(parsed.projection?.subtitles) ? parsed.projection!.subtitles : [],
        providers: Array.isArray(parsed.projection?.providers) ? parsed.projection!.providers : [],
        chapters: Array.isArray(parsed.projection?.chapters) ? parsed.projection!.chapters : [],
        pages: Array.isArray(parsed.projection?.pages) ? parsed.projection!.pages : [],
        images: Array.isArray(parsed.projection?.images) ? parsed.projection!.images : [],
      },
      data: parsed.data,
    };
  } catch {
    return null;
  }
};

const writeSnapshot = async (filePath: string, envelope: ProviderSnapshotEnvelope) => {
  try {
    await mkdir(nodePath.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(envelope, null, 2), "utf-8");
  } catch {
    // Snapshot write failures should not break API responses.
  }
};

const purgeSnapshotArtifacts = async (filePath: string, key: string) => {
  try {
    await unlink(filePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      logRateLimited(`provider-snapshot:file-purge:${key}`, () => {
        log.warn({ error: error?.message || String(error), key }, "provider snapshot filesystem purge failed");
      }, 15_000);
    }
  }

  if (!canonicalStore.isEnabled()) return;

  try {
    await canonicalStore.deleteSnapshotByKey(key);
  } catch (error: any) {
    logRateLimited(`provider-snapshot:db-purge:${key}`, () => {
      log.warn({ error: error?.message || String(error), key }, "provider snapshot db purge failed");
    }, 15_000);
  }
};

const extractProjection = (payload: unknown): ProviderSnapshotProjection => {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const results = isRecord(root.results) ? root.results : {};
  const chapterContainer = isRecord(data.chapter) ? data.chapter : isRecord(results.chapter) ? results.chapter : {};

  const anilistId = pickFirst([
    root.anilistID,
    root.anilistId,
    root.anilist_id,
    data.anilistID,
    data.anilistId,
    data.anilist_id,
    results.anilistID,
    results.anilistId,
    results.anilist_id,
  ]);

  const malId = pickFirst([
    root.malID,
    root.malId,
    root.mal_id,
    data.malID,
    data.malId,
    data.mal_id,
    results.malID,
    results.malId,
    results.mal_id,
  ]);

  const bannerImage = pickFirst([
    root.bannerImage,
    root.banner,
    data.bannerImage,
    data.banner,
    results.bannerImage,
    results.banner,
  ]);

  const sources = pickFirst([
    root.sources,
    data.sources,
    results.sources,
    results.streamingLink,
  ]);

  const subtitles = pickFirst([
    root.subtitles,
    root.tracks,
    data.subtitles,
    data.tracks,
    results.subtitles,
    results.tracks,
  ]);

  const providers = pickFirst([
    root.providers,
    root.servers,
    data.providers,
    data.servers,
    results.providers,
    results.servers,
  ]);

  const chapters = pickFirst([
    root.chapters,
    root.mappedChapters,
    data.chapters,
    data.chapterList,
    results.chapters,
    results.chapterList,
  ]);

  const pages = pickFirst([
    root.pages,
    data.pages,
    results.pages,
    chapterContainer.pages,
  ]);

  const images = pickFirst([
    root.images,
    data.images,
    results.images,
  ]);

  const normalizedPages = toArray(pages);
  const normalizedImages = toArray(images);
  const derivedImageEntries = normalizedImages.length > 0 ? normalizedImages : deriveImageEntriesFromPages(normalizedPages);

  return {
    anilistId,
    malId,
    bannerImage,
    sources: toArray(sources),
    subtitles: toArray(subtitles),
    providers: toArray(providers),
    chapters: toArray(chapters),
    pages: normalizedPages,
    images: derivedImageEntries,
  };
};

const buildPayloadResponse = (payload: unknown, statusCode: number, source: string) => {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-provider-snapshot", source);

  const status = Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 500
    ? statusCode
    : 200;

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
};

const buildSnapshotResponse = (snapshot: ProviderSnapshotEnvelope, source: string) =>
  buildPayloadResponse(snapshot.data, snapshot.status, source);

const buildSnapshotMissResponse = (scope: SnapshotScope, requestUrl: URL) => {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-provider-snapshot", "source-miss");

  return new Response(
    JSON.stringify({
      status: 404,
      success: false,
      message: "provider-json snapshot not found",
      scope,
      path: requestUrl.pathname,
      search: buildSnapshotSearch(requestUrl),
    }),
    {
      status: 404,
      headers,
    }
  );
};

export const providerJsonSnapshot = (scope: SnapshotScope): MiddlewareHandler => {
  return async (c, next) => {
    const requestUrl = new URL(c.req.url);
    const method = String(c.req.method || "GET").toUpperCase();

    if (!shouldHandleRequest(scope, requestUrl, method)) {
      await next();
      return;
    }

    const key = buildSnapshotKey(scope, requestUrl);
    const filePath = buildSnapshotPath(scope, requestUrl, key);

    const forceLive = requestUrl.searchParams.get("snapshotRefresh") === "1";
    const sourceOnly = requestUrl.searchParams.get("snapshotSource") === "1";
    const disableRead = requestUrl.searchParams.get("snapshotUse") === "0";
    const disableWrite = requestUrl.searchParams.get("snapshotWrite") === "0";
    const disableFallback = requestUrl.searchParams.get("snapshotFallback") === "0";
    const purgeSnapshot = requestUrl.searchParams.get("snapshotPurge") === "1";
    const normalizedSearch = buildSnapshotSearch(requestUrl);

    if (purgeSnapshot) {
      await purgeSnapshotArtifacts(filePath, key);
    }

    const loadFromCanonicalStore = async (sourceLabel: string) => {
      if (!canonicalStore.isEnabled()) return false;

      try {
        const canonicalSnapshot = await canonicalStore.getSnapshotByKey(key);
        if (!canonicalSnapshot) return false;

        c.res = buildPayloadResponse(canonicalSnapshot.payload, canonicalSnapshot.statusCode, sourceLabel);
        return true;
      } catch (error: any) {
        logRateLimited(`provider-snapshot:db-read:${scope}`, () => {
          log.warn({ error: error?.message || String(error), scope, key }, "canonical snapshot read failed; continuing with filesystem/live");
        }, 15_000);
        return false;
      }
    };

    if (sourceOnly) {
      if (await loadFromCanonicalStore("source-db")) {
        return;
      }

      const sourceSnapshot = await readSnapshot(filePath);
      if (sourceSnapshot) {
        c.res = buildSnapshotResponse(sourceSnapshot, "source");
      } else {
        c.res = buildSnapshotMissResponse(scope, requestUrl);
      }
      return;
    }

    if (!forceLive && !disableRead) {
      if (await loadFromCanonicalStore("db-hit")) {
        return;
      }

      const existing = await readSnapshot(filePath);
      if (existing) {
        c.res = buildSnapshotResponse(existing, "hit");
        return;
      }
    }

    await next();

    const live = c.res;
    const liveJson = await parseJsonResponse(live);

    if (live.status >= 500) {
      if (disableFallback || purgeSnapshot) {
        return;
      }

      if (await loadFromCanonicalStore("db-fallback")) {
        return;
      }

      const fallback = await readSnapshot(filePath);
      if (fallback) {
        c.res = buildSnapshotResponse(fallback, "fallback");
      }
      return;
    }

    if (disableWrite || !liveJson) {
      return;
    }

    const envelope: ProviderSnapshotEnvelope = {
      version: 1,
      scope,
      key,
      savedAt: new Date().toISOString(),
      status: live.status,
      request: {
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        url: requestUrl.toString(),
      },
      projection: extractProjection(liveJson),
      data: liveJson,
    };

    await writeSnapshot(filePath, envelope);

    if (!canonicalStore.isEnabled()) {
      return;
    }

    const responseHeaders = toResponseHeaderRecord(live.headers);
    enqueueCanonicalWrite({
      key,
      scope,
      run: async () => {
        try {
          await canonicalStore.upsertSnapshot({
            key,
            scope,
            routePath: requestUrl.pathname,
            queryString: normalizedSearch,
            statusCode: live.status,
            projection: envelope.projection as Record<string, unknown>,
            payload: envelope.data,
            responseHeaders,
            sourceMode: "live",
            refreshedAt: envelope.savedAt,
            expiresAt: null,
          });

          if (scope === "manga" && /\/home$/i.test(requestUrl.pathname)) {
            const provider = resolveProviderFromPath(scope, requestUrl.pathname) || "unknown";
            await canonicalStore.upsertDailyMangaHome({
              dayKey: envelope.savedAt.slice(0, 10),
              provider,
              payload: envelope.data,
              projection: envelope.projection as Record<string, unknown>,
              sourceSnapshotKey: key,
            });
          }

          const anilistId = toNullableInt(envelope.projection.anilistId);
          const malId = toNullableInt(envelope.projection.malId);
          const provider = resolveProviderFromPath(scope, requestUrl.pathname);

          const sourceCandidates: SourceValidationCandidate[] = [];
          for (const sourceUrl of collectUrls(envelope.projection.sources)) {
            sourceCandidates.push({
              scope,
              provider,
              anilistId,
              malId,
              mediaKind: "source",
              sourceUrl,
              metadata: {
                snapshotKey: key,
                routePath: requestUrl.pathname,
              },
            });
          }

          for (const sourceUrl of collectUrls(envelope.projection.subtitles)) {
            sourceCandidates.push({
              scope,
              provider,
              anilistId,
              malId,
              mediaKind: "subtitle",
              sourceUrl,
              metadata: {
                snapshotKey: key,
                routePath: requestUrl.pathname,
              },
            });
          }

          for (const sourceUrl of collectUrls(envelope.projection.images)) {
            sourceCandidates.push({
              scope,
              provider,
              anilistId,
              malId,
              mediaKind: "image",
              sourceUrl,
              metadata: {
                snapshotKey: key,
                routePath: requestUrl.pathname,
              },
            });
          }

          if (sourceCandidates.length > 0) {
            await canonicalStore.enqueueSourceCandidates(sourceCandidates);
          }
        } catch (error: any) {
          logRateLimited(`provider-snapshot:db-write:${scope}`, () => {
            log.warn({ error: error?.message || String(error), scope, key }, "canonical snapshot write failed; filesystem snapshot retained");
          }, 15_000);
        }
      },
    });
  };
};
