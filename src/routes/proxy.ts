import { Hono } from "hono";
import { ProxyBalancer } from "../lib/proxyBalancer.js";

const proxyRouter = new Hono();

const DEFAULT_STREAM_PROXY_URLS = [
    "https://hoko.tatakai.me/api/v1/streamingProxy",
];

const configuredProxyUrlsFromEnv = (process.env.STREAM_PROXY_URLS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const SELF_PROXY_PATH_MARKERS = [
    "/api/proxy/m3u8-streaming-proxy",
    "/api/v2/hianime/proxy/m3u8-streaming-proxy",
    "/api/v2/anime/hianime/proxy/m3u8-streaming-proxy",
];

const LOCAL_HOST_MARKERS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];
const SELF_HOST_MARKERS = [
    ...LOCAL_HOST_MARKERS,
    "api.tatakai.me",
    String(process.env.ANIWATCH_API_HOSTNAME || "").trim().toLowerCase(),
].filter(Boolean);

const isSelfProxyNode = (url: string) => {
    const normalized = url.toLowerCase();
    const matchesProxyPath = SELF_PROXY_PATH_MARKERS.some((marker) => normalized.includes(marker));
    if (!matchesProxyPath) return false;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (SELF_HOST_MARKERS.some((marker) => host === marker || host.endsWith(`.${marker}`))) {
            return true;
        }
    } catch {
        // Fall back to a string check for non-standard values.
    }

    return SELF_HOST_MARKERS.some((marker) => normalized.includes(marker));
};

const isMokoProxyNode = (url: string) => {
    try {
        const parsed = new URL(url);
        return /(^|\.)moko\.tatakai\.me$/i.test(parsed.hostname);
    } catch {
        return /(^|\.)moko\.tatakai\.me/i.test(url);
    }
};

const externalConfiguredProxyUrls = configuredProxyUrlsFromEnv
    .filter((url) => !isSelfProxyNode(url))
    .filter((url) => !isMokoProxyNode(url));

const configuredProxyUrls = externalConfiguredProxyUrls.length > 0
    ? externalConfiguredProxyUrls
    : DEFAULT_STREAM_PROXY_URLS;
const balancerUrls = configuredProxyUrls;

const DEFAULT_REFERER = process.env.STREAM_PROXY_REFERER || "https://megacloud.club/";
const STREAM_PROXY_PASSWORD = (
    process.env.STREAM_PROXY_PASSWORD || process.env.PROXY_PASSWORD || ""
).trim();
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FALLBACK_UPSTREAM_PROXY_URL = (
    process.env.STREAM_PROXY_FALLBACK_URL ||
    process.env.STREAM_PROXY_DEV_URL ||
    ""
).trim();

const balancer = new ProxyBalancer(balancerUrls);

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            redirect: "follow",
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
};

const buildFallbackProxyRequestUrl = (
    fallbackBaseUrl: string,
    upstreamUrl: string,
    referer?: string,
    userAgent?: string,
    proxyPassword?: string
) => {
    if (!fallbackBaseUrl) return "";

    try {
        const parsed = new URL(fallbackBaseUrl);
        parsed.searchParams.set("url", upstreamUrl);
        if (referer) parsed.searchParams.set("referer", referer);
        if (userAgent) parsed.searchParams.set("userAgent", userAgent);
        if (proxyPassword) parsed.searchParams.set("password", proxyPassword);
        return parsed.toString();
    } catch {
        const joiner = fallbackBaseUrl.includes("?") ? "&" : "?";
        const params = new URLSearchParams({ url: upstreamUrl });
        if (referer) params.set("referer", referer);
        if (userAgent) params.set("userAgent", userAgent);
        if (proxyPassword) params.set("password", proxyPassword);
        return `${fallbackBaseUrl}${joiner}${params.toString()}`;
    }
};

const probeProxyNode = async (url: string, proxyPassword?: string) => {
    const start = performance.now();
    try {
        const probeUrl = isSelfProxyNode(url)
            ? "http://api.tatakai.me/health"
            : (() => {
                  const joiner = url.includes("?") ? "&" : "?";
                  const params = new URLSearchParams({
                      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
                  });
                  if (proxyPassword) params.set("password", proxyPassword);
                  return `${url}${joiner}${params.toString()}`;
              })();
        const resp = await withTimeout(fetch(probeUrl, { method: "GET" }), 4000);
        const latency = Math.round(performance.now() - start);
        const status = resp.status >= 500 ? "offline" : resp.status >= 400 ? "degraded" : "online";
        return { latency, status };
    } catch {
        return { latency: 0, status: "offline" as const };
    }
};

proxyRouter.get("/status", async (c) => {
    const now = Date.now();
    const balancerStats = balancer.getStats();
    const byUrl = new Map(balancerStats.map((node) => [node.url, node]));

    const nodes = await Promise.all(
        configuredProxyUrls.map(async (url, idx) => {
            const existing = byUrl.get(url);
            if (existing) {
                return {
                    ...existing,
                    status:
                        existing.cooldownUntil > now
                            ? "offline"
                            : existing.failures > 0
                              ? "degraded"
                              : "online",
                };
            }

            const probe = await probeProxyNode(url, STREAM_PROXY_PASSWORD);
            return {
                id: `proxy-${idx + 1}`,
                url,
                failures: probe.status === "offline" ? 1 : 0,
                successes: probe.status === "online" ? 1 : 0,
                lastLatencyMs: probe.latency,
                cooldownUntil: 0,
                status: probe.status,
            };
        })
    );

    return c.json({
        success: true,
        hasNodes: nodes.length > 0,
        timestamp: now,
        nodes,
    });
});

const resolveUrl = (target: string, base: string) => {
    try {
        return new URL(target, base).toString();
    } catch {
        return target;
    }
};

const looksLikeManifest = (payload: string) => {
    const text = String(payload || "").trim();
    if (!text) return false;
    if (!text.startsWith("#EXTM3U")) return false;
    return text.includes("#EXT-X-") || text.includes("#EXTINF");
};

const rewritePlaylistUrls = (
    playlistText: string,
    baseUrl: string,
    proxyEndpointPath: string,
    referer: string,
    userAgent?: string,
    proxyPassword?: string
) => {
    return playlistText
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "") return line;

            const rewrite = (targetUrl: string) => {
                const resolved = resolveUrl(targetUrl, baseUrl);
                const params = new URLSearchParams({ url: resolved });
                if (referer) params.set("referer", referer);
                if (userAgent) params.set("userAgent", userAgent);
                if (proxyPassword) params.set("password", proxyPassword);
                params.set("type", "video");
                return `${proxyEndpointPath}?${params.toString()}`;
            };

            if (trimmed.startsWith("#")) {
                return trimmed.replace(/URI="([^"]+)"/g, (_match, p1) => `URI="${rewrite(p1)}"`);
            }

            return rewrite(trimmed);
        })
        .join("\n");
};

proxyRouter.get("/m3u8-streaming-proxy", async (c) => {
    const safeDecode = (value?: string) => {
        if (!value) return "";
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };

    const targetUrl = safeDecode(c.req.query("url")).trim();
    const referer = safeDecode(c.req.query("referer")).trim() || DEFAULT_REFERER;
    const rawUserAgent = safeDecode(c.req.query("userAgent")).trim();
    const requestedUserAgent = rawUserAgent || DEFAULT_USER_AGENT;
    const requestedRange = c.req.header("range") || "";
    const requestType = safeDecode(c.req.query("type")).trim().toLowerCase();

    let proxyEndpointPath = "/api/proxy/m3u8-streaming-proxy";
    try {
        const pathname = new URL(c.req.url).pathname;
        if (pathname.endsWith("/m3u8-streaming-proxy")) {
            proxyEndpointPath = pathname;
        }
    } catch {
        // Keep default path when URL parsing fails.
    }

    if (!targetUrl) {
        return c.json({ success: false, message: "Missing url query param" }, 400);
    }

    let targetOrigin = "";
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch {
        targetOrigin = "";
    }

    const refererCandidates = Array.from(
        new Set(
            [
                referer,
                DEFAULT_REFERER,
                targetOrigin ? `${targetOrigin}/` : "",
                referer.replace("megacloud.blog", "megacloud.club"),
                referer.replace("megacloud.club", "megacloud.blog"),
                "https://megacloud.blog/",
                "https://megacloud.club/",
                "https://megacloud.tv/",
                "https://megaup.cc/",
                "https://rrr.megaup.cc/",
                "https://dokicloud.one/",
                "https://rabbitstream.net/",
            ].filter(Boolean)
        )
    );
    const maxRefererAttempts = requestType === "video" ? 3 : 2;
    const activeRefererCandidates = refererCandidates.slice(0, maxRefererAttempts);
    const maxUpstreamAttempts = requestType === "video" ? 4 : 3;

    const buildHeaders = (ref: string): Record<string, string> => {
        const isPlaylistRequest = /\.m3u8(?:$|[?#])/i.test(targetUrl);
        const headers: Record<string, string> = {
            "User-Agent": requestedUserAgent,
            "Accept": isPlaylistRequest
                ? "application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream;q=0.9, */*;q=0.8"
                : "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        };

        // Forward byte ranges for media segments, but avoid ranged playlist requests.
        if (requestedRange && !isPlaylistRequest) headers.Range = requestedRange;

        if (ref) {
            headers.Referer = ref;
            try {
                headers.Origin = new URL(ref).origin;
            } catch {
                // noop
            }
        }

        return headers;
    };

    const isPlaylistLike = (response: Response) => {
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        return /\.m3u8(?:$|[?#])/i.test(targetUrl) || contentType.includes("mpegurl") || contentType.includes("x-mpegurl");
    };

    const isLikelyHtmlPayload = (response: Response) => {
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        return contentType.includes("text/html") || contentType.includes("application/json");
    };

    try {
        let upstream: Response | null = null;
        let successfulReferer = referer;
        let playlistBaseUrl = targetUrl;
        let remainingAttemptBudget = maxUpstreamAttempts;
        let lastFailure: { status: number; referer: string; via: "direct" | "balancer"; reason: string } = {
            status: 502,
            referer,
            via: "direct",
            reason: "no acceptable upstream response",
        };

        const isAcceptableResponse = async (
            response: Response,
            context: { referer: string; via: "direct" | "balancer" }
        ) => {
            if (!(response.ok || response.status === 206)) {
                lastFailure = {
                    status: response.status,
                    referer: context.referer,
                    via: context.via,
                    reason: `upstream status ${response.status}`,
                };
                return false;
            }

            if (isPlaylistLike(response)) {
                const payloadText = await response.clone().text().catch(() => "");
                if (!looksLikeManifest(payloadText)) {
                    lastFailure = {
                        status: response.status,
                        referer: context.referer,
                        via: context.via,
                        reason: "invalid or non-HLS playlist payload",
                    };
                    return false;
                }
            }

            if (requestType === "video" && !isPlaylistLike(response) && isLikelyHtmlPayload(response)) {
                lastFailure = {
                    status: response.status,
                    referer: context.referer,
                    via: context.via,
                    reason: "non-media response payload",
                };
                return false;
            }

            return true;
        };

        const isProxyHop = c.req.header("X-Proxy-Hop") === "1";
        const isVideoSegment = !targetUrl.toLowerCase().includes(".m3u8") && c.req.query("type") === "video";

        let balancerTemporarilyBypassed = false;

        for (const ref of activeRefererCandidates) {
            const headers = buildHeaders(ref);
            if (isProxyHop) headers["X-Proxy-Hop"] = "1";

            const shouldBypassBalancer = isProxyHop || isVideoSegment || balancerTemporarilyBypassed;

            if (balancer.hasNodes && !shouldBypassBalancer) {
                if (remainingAttemptBudget <= 0) break;
                remainingAttemptBudget -= 1;

                try {
                    const viaBalancer = await balancer.fetch(
                        targetUrl,
                        { method: "GET", headers },
                        9000,
                        {
                            referer: ref,
                            userAgent: requestedUserAgent,
                            type: "video",
                            password: STREAM_PROXY_PASSWORD,
                        }
                    );
                    if (await isAcceptableResponse(viaBalancer, { referer: ref, via: "balancer" })) {
                        upstream = viaBalancer;
                        successfulReferer = ref;
                        break;
                    } else {
                        console.warn(`[Proxy Balancer] Failed for ${targetUrl} with ref ${ref}. Status: ${viaBalancer.status}`);
                    }
                } catch (e: any) {
                    if (String(e?.message || "").toLowerCase().includes("circuit breaker")) {
                        balancerTemporarilyBypassed = true;
                    }
                    lastFailure = {
                        status: 502,
                        referer: ref,
                        via: "balancer",
                        reason: e?.message ? `balancer error: ${e.message}` : "balancer error",
                    };
                    console.error(`[Proxy Balancer] Error for ${targetUrl}:`, e.message);
                }
            }

            if (upstream) break;
            if (remainingAttemptBudget <= 0) break;
            remainingAttemptBudget -= 1;

            try {
                const direct = await fetchWithTimeout(targetUrl, { method: "GET", headers }, 9000);
                if (await isAcceptableResponse(direct, { referer: ref, via: "direct" })) {
                    upstream = direct;
                    successfulReferer = ref;
                    break;
                } else {
                    console.warn(`[Proxy Direct] Failed for ${targetUrl} with ref ${ref}. Status: ${direct.status}`);
                }
            } catch (e: any) {
                lastFailure = {
                    status: 502,
                    referer: ref,
                    via: "direct",
                    reason: e?.message ? `direct fetch error: ${e.message}` : "direct fetch error",
                };
                console.error(`[Proxy Direct] Error for ${targetUrl}:`, e.message);
            }
        }

        if (!upstream && remainingAttemptBudget <= 0) {
            lastFailure = {
                status: 502,
                referer: lastFailure.referer,
                via: lastFailure.via,
                reason: "upstream attempt budget exhausted",
            };
        }

        if (!upstream && FALLBACK_UPSTREAM_PROXY_URL && remainingAttemptBudget > 0) {
            const fallbackRef = lastFailure.referer || referer;
            const fallbackRequestUrl = buildFallbackProxyRequestUrl(
                FALLBACK_UPSTREAM_PROXY_URL,
                targetUrl,
                fallbackRef,
                requestedUserAgent,
                STREAM_PROXY_PASSWORD,
            );

            const isRecursiveFallback = (() => {
                if (!fallbackRequestUrl) return true;
                try {
                    const fallbackParsed = new URL(FALLBACK_UPSTREAM_PROXY_URL);
                    const targetParsed = new URL(targetUrl);
                    return (
                        targetParsed.origin === fallbackParsed.origin &&
                        targetParsed.pathname === fallbackParsed.pathname
                    );
                } catch {
                    return false;
                }
            })();

            if (!isRecursiveFallback && fallbackRequestUrl) {
                remainingAttemptBudget -= 1;

                try {
                    const fallbackResponse = await fetchWithTimeout(
                        fallbackRequestUrl,
                        {
                            method: "GET",
                            headers: {
                                "Accept": "*/*",
                                "User-Agent": requestedUserAgent,
                            },
                        },
                        12000
                    );

                    if (await isAcceptableResponse(fallbackResponse, { referer: fallbackRef, via: "direct" })) {
                        upstream = fallbackResponse;
                        successfulReferer = fallbackRef;
                        playlistBaseUrl = fallbackRequestUrl;
                    } else {
                        console.warn(`[Proxy Fallback] Failed for ${targetUrl}. Status: ${fallbackResponse.status}`);
                    }
                } catch (e: any) {
                    lastFailure = {
                        status: 502,
                        referer: fallbackRef,
                        via: "direct",
                        reason: e?.message ? `fallback proxy error: ${e.message}` : "fallback proxy error",
                    };
                    console.error(`[Proxy Fallback] Error for ${targetUrl}:`, e.message);
                }
            }
        }

        if (!upstream) {
            const statusCode = lastFailure.status >= 400 && lastFailure.status < 600 ? lastFailure.status : 502;
            return c.json(
                {
                    success: false,
                    message: `Upstream stream request failed: ${lastFailure.reason}`,
                    target: targetUrl,
                    refererTried: lastFailure.referer,
                    via: lastFailure.via,
                    balancer: balancer.getStats(),
                },
                { status: statusCode as any }
            );
        }

        const contentType = upstream.headers.get("content-type") || "";
        const isPlaylist = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

        if (isPlaylist) {
            const playlist = await upstream.text();
            if (!playlist.trim()) {
                throw new Error("Upstream playlist response was empty");
            }

            const rewritten = rewritePlaylistUrls(
                playlist,
                playlistBaseUrl,
                proxyEndpointPath,
                successfulReferer,
                requestedUserAgent,
                STREAM_PROXY_PASSWORD,
            );
            return new Response(rewritten, {
                status: 200,
                headers: {
                    "Content-Type": "application/vnd.apple.mpegurl",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                },
            });
        }

        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                "Content-Type": contentType || "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                ...(upstream.headers.get("content-length")
                    ? { "Content-Length": upstream.headers.get("content-length") as string }
                    : {}),
                ...(upstream.headers.get("accept-ranges")
                    ? { "Accept-Ranges": upstream.headers.get("accept-ranges") as string }
                    : {}),
                ...(upstream.headers.get("content-range")
                    ? { "Content-Range": upstream.headers.get("content-range") as string }
                    : {}),
            },
        });
    } catch (err) {
        return c.json(
            {
                success: false,
                message: (err as Error).message || "Proxy request failed",
                target: targetUrl,
                balancer: balancer.getStats(),
            },
            502
        );
    }
});

export { proxyRouter };
