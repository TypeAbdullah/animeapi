import { Hono } from "hono";
import {
  getMangaChapters,
  getMangaDetail,
  getMangaFacetCounts,
  getMangaFilterSchema,
  getMangaRead,
  searchManga,
  type MangaReadSelection,
} from "./service.js";
import {
  MANGA_MAPPER_PROVIDERS,
  fetchMapperChapters,
  fetchMapperPages,
  getMapperBridgeConfig,
  isSupportedMangaMapperProvider,
} from "./mapperBridge.js";
import { handleLocalMangaProviderRequest } from "./localProviderHandlers.js";
import { canonicalStore } from "../../lib/canonicalStore.js";
import { refreshMangaDailyHomeSnapshots } from "../../services/canonicalJobs.js";
import { log, logRateLimited } from "../../config/logger.js";

export const mangaRoutes = new Hono();

const PROVIDER_PASSTHROUGH_KEYS = ["mangaball", "allmanga", "atsu", "mangafire"] as const;
const MANGA_PROVIDER_DEFAULT_BASE = "https://api.tatakai.me:3000/manga";

const toNormalizedProviderList = (values: string[]) => {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
};

const getProviderApiBase = () => {
  return String(process.env.MANGA_PROVIDER_API_BASE || MANGA_PROVIDER_DEFAULT_BASE).trim();
};

const normalizePathPrefix = (value: string) => {
  const normalized = String(value || "").trim().replace(/\/+$/g, "");
  if (!normalized || normalized === "/") return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const isProxyableProvider = (provider: string) => {
  return PROVIDER_PASSTHROUGH_KEYS.includes(provider.toLowerCase() as (typeof PROVIDER_PASSTHROUGH_KEYS)[number]);
};

const getTailFromPath = (path: string, marker: string) => {
  const index = path.indexOf(marker);
  if (index < 0) return "";
  const tail = path.slice(index + marker.length);
  return tail || "";
};

const normalizeTailPath = (tail: string) => {
  if (!tail) return "";
  if (tail === "/") return "";
  return tail.startsWith("/") ? tail : `/${tail}`;
};

const buildRelativePathCandidates = (provider: string, tail: string, isAdultAlias: boolean) => {
  const normalizedTail = normalizeTailPath(tail);
  const isTailEmpty = normalizedTail.length === 0;
  const candidates = new Set<string>();

  if (isAdultAlias) {
    candidates.add(`/${provider}/adult${normalizedTail}`);
    candidates.add(`/adult/${provider}${normalizedTail}`);

    if (isTailEmpty) {
      candidates.add(`/${provider}/adult/home`);
      candidates.add(`/adult/${provider}/home`);
    }
  } else {
    candidates.add(`/${provider}${normalizedTail}`);
    if (isTailEmpty) {
      candidates.add(`/${provider}/home`);
    }
  }

  return [...candidates];
};

export const buildMangaRewriteUpstreamCandidates = (
  requestUrl: string,
  provider: string,
  isAdultAlias: boolean,
  baseOverride?: string
) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedProvider) return [];

  const parsedRequestUrl = new URL(requestUrl);
  const marker = isAdultAlias
    ? `/manga/adult/${normalizedProvider}`
    : `/manga/${normalizedProvider}`;
  const tail = getTailFromPath(parsedRequestUrl.pathname, marker);

  const rawBase = String(baseOverride || getProviderApiBase() || "").trim();
  let parsedBase: URL;
  try {
    parsedBase = new URL(rawBase);
  } catch {
    return [];
  }

  const basePrefix = normalizePathPrefix(parsedBase.pathname);
  const rootPrefixes = new Set<string>();

  if (basePrefix.length > 0) {
    rootPrefixes.add(basePrefix);
  }
  rootPrefixes.add("/manga");
  rootPrefixes.add("/api/v2/manga");
  if (basePrefix.length === 0) {
    rootPrefixes.add("");
  }

  const relativeCandidates = buildRelativePathCandidates(normalizedProvider, tail, isAdultAlias);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const rootPrefix of rootPrefixes) {
    for (const relativePath of relativeCandidates) {
      const combinedPath = `${rootPrefix}${relativePath}`.replace(/\/{2,}/g, "/");
      const upstreamUrl = new URL(parsedBase.origin);
      upstreamUrl.pathname = combinedPath.startsWith("/") ? combinedPath : `/${combinedPath}`;
      upstreamUrl.search = parsedRequestUrl.search;

      const href = upstreamUrl.toString();
      if (!seen.has(href)) {
        seen.add(href);
        candidates.push(href);
      }
    }
  }

  return candidates;
};

const toProxyResponse = async (upstream: Response, upstreamUrl: string) => {
  const responseHeaders = new Headers();
  const passthroughHeaders = ["content-type", "cache-control"];

  for (const header of passthroughHeaders) {
    const value = upstream.headers.get(header);
    if (value) {
      responseHeaders.set(header, value);
    }
  }

  responseHeaders.set("x-manga-upstream-url", upstreamUrl);

  const responseBody = await upstream.arrayBuffer();
  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
};

const proxyProviderRequest = async (c: any, provider: string, isAdultAlias: boolean) => {
  const normalizedProvider = provider.toLowerCase();
  if (!isProxyableProvider(normalizedProvider)) {
    return c.json({ status: 404, message: `Unsupported passthrough provider: ${provider}` }, 404);
  }

  const localResponse = await handleLocalMangaProviderRequest(c, normalizedProvider, isAdultAlias);
  if (localResponse) {
    return localResponse;
  }

  const candidateUrls = buildMangaRewriteUpstreamCandidates(c.req.url, normalizedProvider, isAdultAlias);
  if (candidateUrls.length === 0) {
    return c.json(
      {
        status: 500,
        message: "Invalid MANGA_PROVIDER_API_BASE configuration",
        provider: normalizedProvider,
        configuredBase: getProviderApiBase(),
      },
      500
    );
  }

  try {
    const requestHeaders = new Headers();
    const contentType = c.req.header("content-type");
    if (contentType) requestHeaders.set("content-type", contentType);

    const accept = c.req.header("accept");
    if (accept) requestHeaders.set("accept", accept);

    const method = String(c.req.method || "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD"
      ? undefined
      : await c.req.arrayBuffer();

    const canRetry = method === "GET" || method === "HEAD";
    let lastResponse: Response | null = null;
    let lastResponseUrl = "";
    let lastError: string | null = null;

    for (const upstreamUrl of candidateUrls) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method,
          headers: requestHeaders,
          body,
          signal: AbortSignal.timeout(12000),
        });

        lastResponse = upstream;
        lastResponseUrl = upstreamUrl;

        const retryableStatus = upstream.status === 404 || upstream.status === 401 || upstream.status === 403;
        if (!canRetry || upstream.ok || !retryableStatus) {
          return await toProxyResponse(upstream, upstreamUrl);
        }
      } catch (error: any) {
        lastError = error?.message || "Unknown passthrough error";
        if (!canRetry) {
          break;
        }
      }
    }

    if (lastResponse && lastResponseUrl) {
      return await toProxyResponse(lastResponse, lastResponseUrl);
    }

    return c.json(
      {
        status: 502,
        message: "Provider passthrough failed",
        provider: normalizedProvider,
        candidates: candidateUrls,
        error: lastError || "Unknown passthrough error",
      },
      502
    );
  } catch (error: any) {
    return c.json(
      {
        status: 502,
        message: "Provider passthrough failed",
        provider: normalizedProvider,
        error: error?.message || "Unknown passthrough error",
      },
      502
    );
  }
};

const toPositiveInteger = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const shouldForceFreshMangaRequest = (c: any): boolean => {
  return (
    c.req.query("refresh") === "1" ||
    c.req.query("nocache") === "1" ||
    c.req.query("snapshotRefresh") === "1"
  );
};

mangaRoutes.get("/search", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  if (!q) {
    return c.json({ status: 400, message: "Missing required query parameter: q" }, 400);
  }

  const page = toPositiveInteger(c.req.query("page"), 1, 1000);
  const limit = toPositiveInteger(c.req.query("limit"), 24, 50);

  const response = await searchManga(q, page, limit);

  return c.json({
    success: true,
    ...response,
  });
});

mangaRoutes.get("/filters/schema", (c) => {
  return c.json({
    success: true,
    schema: getMangaFilterSchema(),
  });
});

mangaRoutes.get("/filters/counts", async (c) => {
  const q = String(c.req.query("q") || "").trim();
  if (!q) {
    return c.json({
      success: true,
      counts: {
        query: "",
        groups: [],
      },
    });
  }

  const counts = await getMangaFacetCounts(q);
  return c.json({
    success: true,
    counts,
  });
});

mangaRoutes.get("/providers", (c) => {
  return c.json({
    success: true,
    providers: {
      mapper: MANGA_MAPPER_PROVIDERS,
      passthrough: PROVIDER_PASSTHROUGH_KEYS,
    },
    rewriteBase: getProviderApiBase(),
  });
});

mangaRoutes.get("/home/daily", async (c) => {
  const requestUrl = new URL(c.req.url);
  const selectedProviders = toNormalizedProviderList(
    String(c.req.query("providers") || "")
      .split(",")
      .filter(Boolean)
  );

  const providers = selectedProviders.length > 0
    ? selectedProviders
    : [...PROVIDER_PASSTHROUGH_KEYS];

  const dayKey = String(c.req.query("day") || new Date().toISOString().slice(0, 10)).trim();
  const shouldRefresh = c.req.query("refresh") === "1";
  const shouldWarmup = c.req.query("warmup") !== "0";
  const origin = `${requestUrl.protocol}//${requestUrl.host}`;

  const providerPayload: Record<string, unknown> = {};

  if (canonicalStore.isEnabled()) {
    try {
      const rows = await canonicalStore.getDailyMangaHome(dayKey, providers);
      for (const row of rows) {
        providerPayload[row.provider] = row.payload;
      }
    } catch (error: any) {
      logRateLimited("manga-home-daily:canonical-read", () => {
        log.warn({ error: error?.message || String(error) }, "manga daily home canonical read failed; using snapshot fallback");
      }, 15_000);
    }
  }

  const missingProviders = providers.filter((provider) => !(provider in providerPayload));

  if (missingProviders.length > 0) {
    await Promise.all(
      missingProviders.map(async (provider) => {
        try {
          const fallbackUrl = new URL(`/api/v2/manga/${provider}/home`, origin);
          fallbackUrl.searchParams.set("snapshotSource", "1");
          const response = await fetch(fallbackUrl.toString(), {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          });

          if (!response.ok) return;

          const payload = await response.json();
          providerPayload[provider] = payload;

          if (canonicalStore.isEnabled()) {
            await canonicalStore.upsertDailyMangaHome({
              dayKey,
              provider,
              payload,
              projection: {},
              sourceSnapshotKey: null,
            });
          }
        } catch {
          // Best-effort fallback read; keep missing provider if unavailable.
        }
      })
    );
  }

  const stillMissing = providers.filter((provider) => !(provider in providerPayload));

  if (shouldRefresh) {
    const refreshResult = await refreshMangaDailyHomeSnapshots({ origin, providers: stillMissing.length > 0 ? stillMissing : providers });

    if (canonicalStore.isEnabled()) {
      try {
        const refreshedRows = await canonicalStore.getDailyMangaHome(dayKey, providers);
        for (const row of refreshedRows) {
          providerPayload[row.provider] = row.payload;
        }
      } catch (error: any) {
        logRateLimited("manga-home-daily:canonical-read-refresh", () => {
          log.warn({ error: error?.message || String(error) }, "manga daily home canonical refresh read failed");
        }, 15_000);
      }
    }

    return c.json({
      success: true,
      dayKey,
      providers,
      payload: providerPayload,
      missingProviders: providers.filter((provider) => !(provider in providerPayload)),
      refreshed: true,
      refreshResult,
    });
  }

  if (shouldWarmup && stillMissing.length > 0) {
    void refreshMangaDailyHomeSnapshots({ origin, providers: stillMissing });
  }

  return c.json({
    success: true,
    dayKey,
    providers,
    payload: providerPayload,
    missingProviders: providers.filter((provider) => !(provider in providerPayload)),
    warming: shouldWarmup && stillMissing.length > 0,
  });
});

mangaRoutes.get("/mapper/:provider/chapters/:anilistId", async (c) => {
  const provider = decodeURIComponent(c.req.param("provider")).toLowerCase();
  const anilistId = Number.parseInt(String(c.req.param("anilistId") || ""), 10);

  if (!Number.isFinite(anilistId) || anilistId <= 0) {
    return c.json({ status: 400, message: "Invalid AniList ID" }, 400);
  }

  if (!isSupportedMangaMapperProvider(provider)) {
    return c.json({ status: 400, message: `Unsupported provider: ${provider}` }, 400);
  }

  const result = await fetchMapperChapters(provider, anilistId);
  const status = result.ok ? 200 : (result.status as 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503);

  return c.json(
    {
      success: result.ok,
      provider: result.provider,
      anilistId,
      latencyMs: result.latencyMs,
      chapters: result.data,
      error: result.error,
    },
    status
  );
});

mangaRoutes.get("/mapper/:provider/pages", async (c) => {
  const provider = decodeURIComponent(c.req.param("provider")).toLowerCase();
  const chapterId = String(c.req.query("chapterId") || "").trim();

  if (!chapterId) {
    return c.json({ status: 400, message: "Missing required query parameter: chapterId" }, 400);
  }

  if (!isSupportedMangaMapperProvider(provider)) {
    return c.json({ status: 400, message: `Unsupported provider: ${provider}` }, 400);
  }

  const result = await fetchMapperPages(provider, chapterId);
  const status = result.ok ? 200 : (result.status as 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503);

  return c.json(
    {
      success: result.ok,
      provider: result.provider,
      chapterId,
      latencyMs: result.latencyMs,
      pages: result.data,
      error: result.error,
    },
    status
  );
});

mangaRoutes.get("/mapper/:provider/pages/:chapterId", async (c) => {
  const provider = decodeURIComponent(c.req.param("provider")).toLowerCase();
  const chapterId = decodeURIComponent(c.req.param("chapterId"));

  if (!isSupportedMangaMapperProvider(provider)) {
    return c.json({ status: 400, message: `Unsupported provider: ${provider}` }, 400);
  }

  const result = await fetchMapperPages(provider, chapterId);
  const status = result.ok ? 200 : (result.status as 400 | 401 | 403 | 404 | 408 | 429 | 500 | 502 | 503);

  return c.json(
    {
      success: result.ok,
      provider: result.provider,
      chapterId,
      latencyMs: result.latencyMs,
      pages: result.data,
      error: result.error,
    },
    status
  );
});

mangaRoutes.all("/mangaball", async (c) => proxyProviderRequest(c, "mangaball", false));
mangaRoutes.all("/mangaball/*", async (c) => proxyProviderRequest(c, "mangaball", false));
mangaRoutes.all("/allmanga", async (c) => proxyProviderRequest(c, "allmanga", false));
mangaRoutes.all("/allmanga/*", async (c) => proxyProviderRequest(c, "allmanga", false));
mangaRoutes.all("/atsu", async (c) => proxyProviderRequest(c, "atsu", false));
mangaRoutes.all("/atsu/*", async (c) => proxyProviderRequest(c, "atsu", false));
mangaRoutes.all("/mangafire", async (c) => proxyProviderRequest(c, "mangafire", false));
mangaRoutes.all("/mangafire/*", async (c) => proxyProviderRequest(c, "mangafire", false));

mangaRoutes.all("/adult/:provider", async (c) => {
  const provider = decodeURIComponent(c.req.param("provider")).toLowerCase();
  return proxyProviderRequest(c, provider, true);
});

mangaRoutes.all("/adult/:provider/*", async (c) => {
  const provider = decodeURIComponent(c.req.param("provider")).toLowerCase();
  return proxyProviderRequest(c, provider, true);
});

mangaRoutes.get("/:id/chapters", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const forceFresh = shouldForceFreshMangaRequest(c);
  const provider = String(c.req.query("provider") || "").trim();
  const providersQuery = String(c.req.query("providers") || "").trim();
  const providersFromQuery = providersQuery
    ? providersQuery.split(",").map((value) => value.trim())
    : [];
  const providers = toNormalizedProviderList([
    ...providersFromQuery,
    provider,
  ]);
  const language = c.req.query("language");

  const response = await getMangaChapters(id, {
    providers: providers.length > 0 ? providers : undefined,
    language,
    forceFresh,
  });
  if (!response) {
    return c.json({ status: 404, message: "Manga not found" }, 404);
  }

  return c.json({
    success: true,
    ...response,
  });
});

mangaRoutes.get("/:id/read", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const forceFresh = shouldForceFreshMangaRequest(c);
  const selection: MangaReadSelection = {
    chapterKey: c.req.query("chapterKey") ? decodeURIComponent(String(c.req.query("chapterKey"))) : undefined,
    provider: c.req.query("provider") ? String(c.req.query("provider")).toLowerCase() : undefined,
    chapterId: c.req.query("chapterId") ? decodeURIComponent(String(c.req.query("chapterId"))) : undefined,
    chapterNumber: c.req.query("chapterNumber")
      ? Number.parseFloat(String(c.req.query("chapterNumber")))
      : undefined,
  };

  const hasChapterKey = Boolean(selection.chapterKey);
  const hasProviderSelection = Boolean(selection.provider && selection.chapterId);
  if (!hasChapterKey && !hasProviderSelection) {
    return c.json(
      {
        status: 400,
        message: "Must provide chapterKey OR provider + chapterId",
      },
      400
    );
  }

  const result = await getMangaRead(id, selection, { forceFresh });
  if (!result.response) {
    const status = result.error === "Invalid chapter key" ? 400 : 502;
    return c.json(
      {
        status,
        message: result.error || "Failed to resolve chapter read payload",
        partial: result.partial,
        failedProviders: result.failedProviders,
        guidance: result.guidance,
      },
      status as 400 | 502
    );
  }

  return c.json({
    success: true,
    partial: result.partial,
    failedProviders: result.failedProviders,
    data: result.response,
  });
});

mangaRoutes.get("/:id/read/:chapterKey", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const chapterKey = decodeURIComponent(c.req.param("chapterKey"));
  const forceFresh = shouldForceFreshMangaRequest(c);

  const result = await getMangaRead(id, { chapterKey }, { forceFresh });
  if (!result.response) {
    const status = result.error === "Invalid chapter key" ? 400 : 502;
    return c.json(
      {
        status,
        message: result.error || "Failed to resolve chapter read payload",
        partial: result.partial,
        failedProviders: result.failedProviders,
        guidance: result.guidance,
      },
      status as 400 | 502
    );
  }

  return c.json({
    success: true,
    partial: result.partial,
    failedProviders: result.failedProviders,
    data: result.response,
  });
});

mangaRoutes.get("/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const forceFresh = shouldForceFreshMangaRequest(c);
  const detail = await getMangaDetail(id, { forceFresh });

  if (!detail) {
    return c.json({ status: 404, message: "Manga not found" }, 404);
  }

  return c.json({
    success: true,
    ...detail,
  });
});

mangaRoutes.get("/", (c) => {
  return c.json({
    service: "manga",
    description: "Unified manga API with mapper integration, provider passthrough, and adult alias routes",
    idStrategy: {
      default: "Bare numeric IDs resolve as AniList IDs",
      supportedFormats: ["<numeric>", "anilist:<id>", "mal:<id>", "provider:<provider>|<id>", "slug:<slug>"],
    },
    providers: {
      mapper: MANGA_MAPPER_PROVIDERS,
      passthrough: PROVIDER_PASSTHROUGH_KEYS,
      mapperBridge: getMapperBridgeConfig(),
      rewriteBase: getProviderApiBase(),
      adultAlias: "/adult/:provider/* -> /:provider/adult/*",
    },
    endpoints: [
      "/search?q=...",
      "/filters/schema",
      "/filters/counts?q=...",
      "/providers",
      "/mapper/:provider/chapters/:anilistId",
      "/mapper/:provider/pages?chapterId=...",
      "/mapper/:provider/pages/:chapterId",
      "/:id",
      "/:id/chapters?providers=mangadex,asurascans",
      "/:id/read?provider=mangadex&chapterId=...",
      "/:id/read?chapterKey=...",
      "/:id/read/:chapterKey",
      "/mangaball",
      "/mangaball/*",
      "/allmanga",
      "/allmanga/*",
      "/atsu",
      "/atsu/*",
      "/mangafire",
      "/mangafire/*",
      "/adult/:provider",
      "/adult/:provider/*",
    ],
  });
});
