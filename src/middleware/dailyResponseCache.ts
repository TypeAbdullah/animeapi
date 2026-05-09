import type { MiddlewareHandler } from "hono";
import { cache } from "../config/cache.js";

type CachedHttpResponse = {
  status: number;
  bodyBase64: string;
  contentType: string;
};

const DAILY_CACHE_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = "route-response:v1";
const CACHEABLE_METHOD = "GET";
const SKIP_CACHE_ERROR = "skip-cache";
const CACHE_CONTROL_VALUE = "public, max-age=60, s-maxage=86400, stale-while-revalidate=86400";

const shouldUseCache = (url: URL, method: string) => {
  if (method !== CACHEABLE_METHOD) return false;
  if (url.searchParams.get("nocache") === "1") return false;
  return true;
};

const isCacheableResponse = (status: number, contentType: string, bodyBytes: number) => {
  if (status >= 500) return false;
  if (bodyBytes > 1024 * 1024) return false;
  if (!contentType.toLowerCase().includes("application/json")) return false;
  return true;
};

export const dailyResponseCache = (scope: string): MiddlewareHandler => {
  return async (c, next) => {
    const parsedUrl = new URL(c.req.url);
    const method = String(c.req.method || "GET").toUpperCase();

    if (!shouldUseCache(parsedUrl, method)) {
      await next();
      return;
    }

    const cacheKey = `${CACHE_PREFIX}:${scope}:${parsedUrl.pathname}${parsedUrl.search}`;
    let handledLiveResponse = false;

    try {
      const cached = await cache.getOrSet<CachedHttpResponse>(
        async () => {
          handledLiveResponse = true;
          await next();

          const live = c.res;
          const contentType = String(live.headers.get("content-type") || "application/json; charset=utf-8");
          const bodyBuffer = Buffer.from(await live.clone().arrayBuffer());

          if (!isCacheableResponse(live.status, contentType, bodyBuffer.byteLength)) {
            throw new Error(SKIP_CACHE_ERROR);
          }

          return {
            status: live.status,
            bodyBase64: bodyBuffer.toString("base64"),
            contentType,
          };
        },
        cacheKey,
        DAILY_CACHE_SECONDS,
        {
          staleWhileRevalidateSeconds: DAILY_CACHE_SECONDS,
          allowStaleOnError: true,
        }
      );

      c.res = new Response(Buffer.from(cached.bodyBase64, "base64"), {
        status: cached.status,
        headers: {
          "content-type": cached.contentType,
          "cache-control": CACHE_CONTROL_VALUE,
          "x-response-cache": "daily",
        },
      });
    } catch (error: any) {
      if (error?.message === SKIP_CACHE_ERROR) {
        if (!handledLiveResponse) {
          await next();
        }
        return;
      }

      throw error;
    }
  };
};
