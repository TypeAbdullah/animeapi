import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { log, logRateLimited } from "../config/logger.js";

const HEALTH_PATHS = new Set(["/health", "/v"]);
const SLOW_REQUEST_MS = 1500;

export const logging: MiddlewareHandler = async (c, next) => {
    const startedAt = Date.now();
    const { pathname } = new URL(c.req.url);

    await next();

    if (HEALTH_PATHS.has(pathname)) return;

    const durationMs = Date.now() - startedAt;
    const status = c.res.status;
    const method = c.req.method;

    const payload = {
        method,
        path: pathname,
        status,
        durationMs,
    };

    const spamKey = `${method}:${pathname}:${status}`;
    const isMapperUpstreamFailure = status === 503 && pathname.startsWith("/api/v2/manga/mapper/");

    if (status >= 500) {
        logRateLimited(`req:error:${spamKey}`, () => {
            if (isMapperUpstreamFailure) {
                log.warn(payload, "mapper upstream unavailable (rate-limited)");
                return;
            }
            log.error(payload, "request failed");
        }, 15000);
        return;
    }

    if (status >= 400 || durationMs >= SLOW_REQUEST_MS) {
        logRateLimited(`req:warn:${spamKey}:${durationMs >= SLOW_REQUEST_MS ? "slow" : "http"}`, () => {
            log.warn(payload, status >= 400 ? "request warning" : "slow request");
        }, 10000);
        return;
    }

    if (!env.isProduction) {
        log.info(payload, "request complete");
    }
};
