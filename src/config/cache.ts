import { Redis } from "ioredis";
import { env } from "./env.js";
import { log, logRateLimited } from "./logger.js";

type CacheEnvelope<T> = {
    __aniwatchCacheV: 1;
    value: T;
    expiresAt: number;
    staleUntil: number;
    createdAt: number;
};

type GetOrSetOptions = {
    staleWhileRevalidateSeconds?: number;
    allowStaleOnError?: boolean;
    ttlJitterRatio?: number;
};

export class AniwatchAPICache {
    private static instance: AniwatchAPICache | null = null;

    private client: Redis | null;
    public enabled: boolean = false;
    private redisBackoffUntil = 0;
    private redisConnectInFlight: Promise<void> | null = null;
    private inflightFetches = new Map<string, Promise<unknown>>();
    private localHotCache = new Map<string, CacheEnvelope<unknown>>();
    private localHotCacheMaxEntries = 2000;

    static enabled = false;
    // 5 mins, 5 * 60
    static DEFAULT_CACHE_EXPIRY_SECONDS = 300 as const;
    static CACHE_EXPIRY_HEADER_NAME = "Aniwatch-Cache-Expiry" as const;
    static DEFAULT_STALE_WHILE_REVALIDATE_SECONDS =
        env.ANIWATCH_API_STALE_WHILE_REVALIDATE;

    constructor() {
        const redisConnURL = env.ANIWATCH_API_REDIS_CONN_URL;
        this.enabled = AniwatchAPICache.enabled = Boolean(redisConnURL);
        this.client = this.enabled
            ? new Redis(String(redisConnURL), {
                  lazyConnect: true,
                  connectTimeout: 1500,
                  maxRetriesPerRequest: 1,
                  enableOfflineQueue: false,
                  retryStrategy: (times) => Math.min(times * 150, 1000),
              })
            : null;

        if (this.client) {
            this.client.on("error", (err) => {
                this.markRedisBackoff(err);
                logRateLimited("cache:redis:client-error", () => {
                    log.warn(
                        { error: (err as Error)?.message || String(err) },
                        "cache redis client error"
                    );
                });
            });

            this.client.on("ready", () => {
                this.redisBackoffUntil = 0;
            });
        }
    }

    private isRedisBackoffActive() {
        return Date.now() < this.redisBackoffUntil;
    }

    private isRedisReady() {
        if (!this.client) return false;
        return this.client.status === "ready";
    }

    private ensureRedisConnected() {
        if (!this.client) return;

        const status = this.client.status;
        if (
            status === "ready" ||
            status === "connect" ||
            status === "connecting" ||
            status === "reconnecting"
        ) {
            return;
        }

        if (this.redisConnectInFlight) return;

        this.redisConnectInFlight = this.client
            .connect()
            .catch((err) => {
                this.markRedisBackoff(err);
                const message = this.getErrorMessage(err);
                if (this.isRedisUnavailableMessage(message)) return;

                logRateLimited("cache:redis:connect:unexpected", () => {
                    log.warn({ error: message }, "cache redis connect failed");
                });
            })
            .finally(() => {
                this.redisConnectInFlight = null;
            });
    }

    private getErrorMessage(err: unknown) {
        return String((err as Error)?.message || err || "").toLowerCase();
    }

    private isRedisUnavailableMessage(message: string) {
        return (
            message.includes("maxretriesperrequest") ||
            message.includes("etimedout") ||
            message.includes("econnrefused") ||
            message.includes("enotfound") ||
            message.includes("stream isn't writeable") ||
            message.includes("stream isn't writable") ||
            message.includes("connection is closed") ||
            message.includes("socket closed") ||
            message.includes("reconnecting")
        );
    }

    private markRedisBackoff(err: unknown) {
        const message = this.getErrorMessage(err);
        if (this.isRedisUnavailableMessage(message)) {
            this.redisBackoffUntil = Date.now() + 60_000;
        }
    }

    static getInstance() {
        if (!AniwatchAPICache.instance) {
            AniwatchAPICache.instance = new AniwatchAPICache();
        }
        return AniwatchAPICache.instance;
    }

    /**
     * @param expirySeconds set to 300 (5 mins) by default
     */
    async getOrSet<T>(
        dataGetter: () => Promise<T>,
        key: string,
        expirySeconds: number = AniwatchAPICache.DEFAULT_CACHE_EXPIRY_SECONDS,
        options: GetOrSetOptions = {}
    ) {
        const staleWhileRevalidateSeconds =
            options.staleWhileRevalidateSeconds ??
            AniwatchAPICache.DEFAULT_STALE_WHILE_REVALIDATE_SECONDS;
        const allowStaleOnError = options.allowStaleOnError ?? true;
        const ttlJitterRatio = options.ttlJitterRatio ?? 0.08;
        const now = Date.now();

        const cached = await this.getCacheEnvelope<T>(key);
        if (cached && now < cached.expiresAt) {
            return cached.value;
        }

        if (cached && now < cached.staleUntil) {
            void this.revalidateInBackground<T>(
                key,
                dataGetter,
                expirySeconds,
                staleWhileRevalidateSeconds,
                ttlJitterRatio
            );
            return cached.value;
        }

        try {
            return await this.fetchAndSet<T>(
                key,
                dataGetter,
                expirySeconds,
                staleWhileRevalidateSeconds,
                ttlJitterRatio
            );
        } catch (err) {
            if (allowStaleOnError && cached && now < cached.staleUntil) {
                return cached.value;
            }
            throw err;
        }
    }

    private applyJitter(baseSeconds: number, ratio: number): number {
        if (baseSeconds <= 0) return 1;
        const clampedRatio = Math.max(0, Math.min(ratio, 0.4));
        const jitter = Math.round(baseSeconds * clampedRatio * Math.random());
        return Math.max(1, baseSeconds + jitter);
    }

    private upsertLocalHotCache<T>(key: string, envelope: CacheEnvelope<T>) {
        if (this.localHotCache.has(key)) {
            this.localHotCache.delete(key);
        }
        this.localHotCache.set(key, envelope as CacheEnvelope<unknown>);

        if (this.localHotCache.size <= this.localHotCacheMaxEntries) return;

        const oldestKey = this.localHotCache.keys().next().value;
        if (oldestKey) {
            this.localHotCache.delete(oldestKey);
        }
    }

    private parseEnvelope<T>(raw: string): CacheEnvelope<T> | null {
        try {
            const parsed = JSON.parse(raw) as
                | CacheEnvelope<T>
                | { value?: T; expiresAt?: number; staleUntil?: number }
                | T;

            if (
                parsed &&
                typeof parsed === "object" &&
                "__aniwatchCacheV" in parsed &&
                (parsed as CacheEnvelope<T>).__aniwatchCacheV === 1
            ) {
                const envelope = parsed as CacheEnvelope<T>;
                if (
                    typeof envelope.expiresAt === "number" &&
                    typeof envelope.staleUntil === "number"
                ) {
                    return envelope;
                }
            }

            // Backward compatibility for old cache payloads that were plain JSON values.
            const now = Date.now();
            return {
                __aniwatchCacheV: 1,
                value: parsed as T,
                expiresAt: now + 15 * 1000,
                staleUntil: now + 30 * 1000,
                createdAt: now,
            };
        } catch {
            return null;
        }
    }

    private async getCacheEnvelope<T>(key: string): Promise<CacheEnvelope<T> | null> {
        const local = this.localHotCache.get(key) as CacheEnvelope<T> | undefined;
        if (local) return local;

        if (!this.enabled || !this.client) return null;
        if (this.isRedisBackoffActive()) return null;
        if (!this.isRedisReady()) {
            this.ensureRedisConnected();
            return null;
        }

        try {
            const raw = await this.client.get(key);
            if (!raw) return null;

            const envelope = this.parseEnvelope<T>(raw);
            if (!envelope) return null;

            this.upsertLocalHotCache(key, envelope);
            return envelope;
        } catch (err) {
            const message = this.getErrorMessage(err);
            this.markRedisBackoff(err);
            if (this.isRedisUnavailableMessage(message)) {
                logRateLimited("cache:redis:unavailable:get", () => {
                    log.debug(
                        { key, error: message },
                        "cache redis unavailable, serving without redis"
                    );
                }, 60_000);
                return null;
            }

            logRateLimited("cache:redis:get:unexpected", () => {
                log.warn({ key, error: message }, "cache redis get failed");
            });
            return null;
        }
    }

    private async setCacheEnvelope<T>(
        key: string,
        value: T,
        expirySeconds: number,
        staleWhileRevalidateSeconds: number,
        ttlJitterRatio: number
    ) {
        const ttlFreshSeconds = this.applyJitter(expirySeconds, ttlJitterRatio);
        const staleSeconds = Math.max(0, staleWhileRevalidateSeconds);
        const ttlStoreSeconds = Math.max(1, ttlFreshSeconds + staleSeconds);
        const now = Date.now();

        const envelope: CacheEnvelope<T> = {
            __aniwatchCacheV: 1,
            value,
            createdAt: now,
            expiresAt: now + ttlFreshSeconds * 1000,
            staleUntil: now + ttlStoreSeconds * 1000,
        };

        this.upsertLocalHotCache(key, envelope);

        if (!this.enabled || !this.client) return;
        if (this.isRedisBackoffActive()) return;
        if (!this.isRedisReady()) {
            this.ensureRedisConnected();
            return;
        }

        try {
            await this.client.set(key, JSON.stringify(envelope), "EX", ttlStoreSeconds);
        } catch (err) {
            const message = this.getErrorMessage(err);
            this.markRedisBackoff(err);
            if (this.isRedisUnavailableMessage(message)) {
                logRateLimited("cache:redis:unavailable:set", () => {
                    log.debug({ key, error: message }, "cache redis unavailable, skipping set");
                }, 60_000);
                return;
            }

            logRateLimited("cache:redis:set:unexpected", () => {
                log.warn({ key, error: message }, "cache redis set failed");
            });
        }
    }

    private async fetchAndSet<T>(
        key: string,
        dataGetter: () => Promise<T>,
        expirySeconds: number,
        staleWhileRevalidateSeconds: number,
        ttlJitterRatio: number
    ): Promise<T> {
        const existingInflight = this.inflightFetches.get(key) as
            | Promise<T>
            | undefined;
        if (existingInflight) return existingInflight;

        const task = (async () => {
            try {
                const fresh = await dataGetter();
                await this.setCacheEnvelope(
                    key,
                    fresh,
                    expirySeconds,
                    staleWhileRevalidateSeconds,
                    ttlJitterRatio
                );
                return fresh;
            } finally {
                this.inflightFetches.delete(key);
            }
        })();

        this.inflightFetches.set(key, task as Promise<unknown>);
        return task;
    }

    private async revalidateInBackground<T>(
        key: string,
        dataGetter: () => Promise<T>,
        expirySeconds: number,
        staleWhileRevalidateSeconds: number,
        ttlJitterRatio: number
    ) {
        if (this.inflightFetches.has(key)) return;
        try {
            await this.fetchAndSet(
                key,
                dataGetter,
                expirySeconds,
                staleWhileRevalidateSeconds,
                ttlJitterRatio
            );
        } catch {
            // SWR background refresh failures are intentionally silent.
        }
    }

    closeConnection() {
        this.client
            ?.quit()
            ?.then(() => {
                this.client = null;
                AniwatchAPICache.instance = null;
                log.info("aniwatch-api redis connection closed and cache instance reset");
            })
            .catch((err) => {
                log.error({ err }, "aniwatch-api error while closing redis connection");
            });
    }
}

export const cache = AniwatchAPICache.getInstance();
