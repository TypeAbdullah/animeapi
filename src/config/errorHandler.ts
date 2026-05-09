import { HiAnimeError } from "../vendor/aniwatch/errors/HiAnimeError.js";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env } from "./env.js";
import { log, logRateLimited } from "./logger.js";

export const errorHandler: ErrorHandler = (err, c) => {
    let status: ContentfulStatusCode = 500;
    let message = "Internal Server Error";

    if (err instanceof HiAnimeError) {
        status = err.status as ContentfulStatusCode;
        message = err.message;
    }

    const path = c.req.path;
    const method = c.req.method;
    const noiseKey = `${method}:${path}:${status}:${message}`;
    const isUpstreamOrExpectedFailure =
        status === 403 ||
        status === 404 ||
        status === 429 ||
        status === 503 ||
        /service unavailable|status 403|not found|fetcherror/i.test(message);

    logRateLimited(
        `err:${noiseKey}`,
        () => {
            if (isUpstreamOrExpectedFailure) {
                log.warn({ path, method, status, message }, "request error (rate-limited)");
                return;
            }
            log.error({ err, path, method }, "request error");
        },
        isUpstreamOrExpectedFailure ? 15000 : 5000
    );

    return c.json(
        {
            status,
            message,
            ...(env.isProduction
                ? {}
                : { details: err.message, stack: err.stack }),
        },
        status
    );
};

export const notFoundHandler: NotFoundHandler = (c) => {
    const status: ContentfulStatusCode = 404;
    const message = "Not Found";

    log.warn({ path: c.req.path, method: c.req.method }, "route not found");
    return c.json({ status, message }, status);
};
