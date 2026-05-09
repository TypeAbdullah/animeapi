import { cache as aniwatchCache } from "../config/cache.js";

const REDIS_UNAVAILABLE_MARKERS = [
    "stream isn't writeable",
    "stream isn't writable",
    "connection is closed",
    "socket closed",
    "econnrefused",
    "etimedout",
    "enotfound",
    "maxretriesperrequest",
    "reconnecting",
];

const getRedisClient = (): any => {
    // Accessing private client intentionally through runtime object shape.
    return (aniwatchCache as any)?.client || null;
};

let reconnectInFlight: Promise<void> | null = null;

const getErrorMessage = (err: unknown) =>
    String((err as Error)?.message || err || "").toLowerCase();

const isRedisUnavailableError = (err: unknown) => {
    const message = getErrorMessage(err);
    return REDIS_UNAVAILABLE_MARKERS.some((marker) => message.includes(marker));
};

const triggerReconnectIfNeeded = (client: any) => {
    const status = String(client?.status || "").toLowerCase();
    if (status !== "wait" && status !== "end" && status !== "close") return;

    const runtimeCache = aniwatchCache as any;
    if (typeof runtimeCache?.ensureRedisConnected === "function") {
        runtimeCache.ensureRedisConnected();
        return;
    }

    if (!client?.connect || reconnectInFlight) return;

    reconnectInFlight = Promise.resolve()
        .then(() => client.connect())
        .catch(() => {
            // Reconnect is best-effort only.
        })
        .finally(() => {
            reconnectInFlight = null;
        });
};

const withSafeRedis = async <T>(
    run: (client: any) => Promise<T>,
    fallback: T
): Promise<T> => {
    const client = getRedisClient();
    if (!aniwatchCache.enabled || !client) return fallback;

    const status = String(client.status || "").toLowerCase();
    if (status !== "ready") {
        triggerReconnectIfNeeded(client);
        return fallback;
    }

    try {
        return await run(client);
    } catch (err) {
        if (isRedisUnavailableError(err)) {
            triggerReconnectIfNeeded(client);
            return fallback;
        }
        return fallback;
    }
};

export class Cache {
    static async set(key: string, value: any, TTL: number = 300, isJson: boolean = false) {
        const data = isJson ? JSON.stringify(value) : value;
        await withSafeRedis(
            async (client) => {
                await client.set(key, data, "EX", TTL);
                return true;
            },
            false
        );
        return true;
    }

    static async get(key: string, isJson: boolean = false) {
        const data = await withSafeRedis<string | null>(
            async (client) => {
                const value = await client.get(key);
                return value || null;
            },
            null
        );

        if (data && isJson) {
            try {
                return JSON.parse(data);
            } catch {
                return data;
            }
        }
        return data;
    }

    static async del(key: string) {
        await withSafeRedis(
            async (client) => {
                await client.del(key);
                return true;
            },
            false
        );
        return true;
    }
}
