type ProxyHealth = {
    id: string;
    url: string;
    failures: number;
    successes: number;
    lastLatencyMs: number;
    cooldownUntil: number;
    lastFailureStatus?: number;
    lastFailureAt?: number;
};

const DEFAULT_TIMEOUT_MS = 12000;
const COOLDOWN_BASE_MS = 16000;
const MAX_COOLDOWN_MS = 45000;
const COOLDOWN_AFTER_FAILURES = 3;
const CIRCUIT_BREAKER_MS = 10000;
const CIRCUIT_FAILURE_THRESHOLD = 5;

export class ProxyBalancer {
    private nodes: ProxyHealth[];
    private rotationCursor = 0;
    private consecutiveFailures = 0;
    private circuitOpenUntil = 0;
    private inFlightManifestRequests = new Map<string, Promise<Response>>();

    constructor(urls: string[]) {
        this.nodes = urls
            .map((url, index) => ({
                id: `proxy-${index + 1}`,
                url: url.trim(),
                failures: 0,
                successes: 0,
                lastLatencyMs: 0,
                cooldownUntil: 0,
            }))
            .filter((node) => node.url.length > 0);
    }

    get hasNodes() {
        return this.nodes.length > 0;
    }

    getStats() {
        return this.nodes.map((n) => ({
            id: n.id,
            url: n.url,
            failures: n.failures,
            successes: n.successes,
            lastLatencyMs: n.lastLatencyMs,
            cooldownUntil: n.cooldownUntil,
            lastFailureStatus: n.lastFailureStatus,
            lastFailureAt: n.lastFailureAt,
            circuitOpenUntil: this.circuitOpenUntil,
            consecutiveFailures: this.consecutiveFailures,
            inflightManifestRequests: this.inFlightManifestRequests.size,
        }));
    }

    private isCircuitOpen() {
        return this.circuitOpenUntil > Date.now();
    }

    private openCircuit() {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
    }

    private score(node: ProxyHealth): number {
        const now = Date.now();
        if (node.cooldownUntil > now) return Number.POSITIVE_INFINITY;
        const penalty = node.failures * 320;
        const latency = node.lastLatencyMs || 100;
        return latency + penalty;
    }

    private pickNode(): ProxyHealth | null {
        if (!this.nodes.length) return null;
        const now = Date.now();
        const eligible = this.nodes.filter((node) => node.cooldownUntil <= now);
        const pool = eligible.length > 0 ? eligible : this.nodes;
        const sorted = [...pool].sort((a, b) => this.score(a) - this.score(b));
        if (sorted.length <= 1) return sorted[0] || null;

        // Rotate between top candidates so traffic does not stick permanently to a single node.
        const topCandidates = sorted.slice(0, Math.min(2, sorted.length));
        const selected = topCandidates[this.rotationCursor % topCandidates.length] || topCandidates[0];
        this.rotationCursor = (this.rotationCursor + 1) % topCandidates.length;
        return selected;
    }

    private reportSuccess(node: ProxyHealth, latencyMs: number) {
        node.successes += 1;
        node.failures = Math.max(0, node.failures - 1.25);
        node.lastLatencyMs = Math.round(latencyMs);
        node.cooldownUntil = 0;
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
    }

    private reportFailure(node: ProxyHealth, status?: number) {
        const now = Date.now();
        const isHardFailure =
            typeof status !== "number" ||
            status === 0 ||
            status === 408 ||
            status === 429 ||
            status >= 500;

        node.lastFailureStatus = status;
        node.lastFailureAt = now;

        if (isHardFailure) {
            node.failures += 1;
            this.consecutiveFailures += 1;
        } else {
            node.failures = Math.min(node.failures + 0.35, 10);
            this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1);
        }

        if (node.failures >= COOLDOWN_AFTER_FAILURES) {
            const factor = Math.min(Math.floor(node.failures), 6);
            const jitter = Math.floor(Math.random() * 800);
            const cooldownMs = Math.min(COOLDOWN_BASE_MS + factor * 2000 + jitter, MAX_COOLDOWN_MS);
            node.cooldownUntil = now + cooldownMs;
        }

        if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            this.openCircuit();
        }
    }

    private shouldDedupeRequest(url: string, init?: RequestInit): boolean {
        const method = String(init?.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") return false;
        return /\.m3u8(?:$|[?#])/i.test(url);
    }

    private buildDedupeKey(
        url: string,
        proxyParams?: Record<string, string | number | boolean | undefined>
    ): string {
        if (!proxyParams) return url;

        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(proxyParams).sort(([a], [b]) => a.localeCompare(b))) {
            if (value === undefined || value === null || value === "") continue;
            params.set(key, String(value));
        }

        return `${url}|${params.toString()}`;
    }

    private async fetchInternal(
        url: string,
        init?: RequestInit,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        proxyParams?: Record<string, string | number | boolean | undefined>
    ): Promise<Response> {
        if (!this.nodes.length) {
            return fetch(url, init);
        }

        if (this.isCircuitOpen()) {
            throw new Error("Proxy circuit breaker open");
        }

        const attempted = new Set<string>();
        let lastError: Error | null = null;

        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.pickNode();
            if (!node || attempted.has(node.id)) continue;
            attempted.add(node.id);

            const query = new URLSearchParams({ url });
            if (proxyParams) {
                for (const [key, value] of Object.entries(proxyParams)) {
                    if (value === undefined || value === null || value === "") continue;
                    query.set(key, String(value));
                }
            }

            const proxyUrl = `${node.url}${node.url.includes("?") ? "&" : "?"}${query.toString()}`;
            const start = performance.now();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const resp = await fetch(proxyUrl, {
                    ...init,
                    headers: {
                        ...init?.headers,
                        "X-Proxy-Hop": "1",
                    },
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                const parsedContentLength = Number(resp.headers.get("content-length") || "");
                const hasExplicitZeroLength = Number.isFinite(parsedContentLength) && parsedContentLength === 0;
                const hasNoUsablePayload = resp.status === 204 || resp.status === 205 || hasExplicitZeroLength;

                if (!resp.ok || hasNoUsablePayload) {
                    this.reportFailure(node, resp.status);
                    lastError = new Error(`Proxy ${node.id} failed with ${resp.status}`);
                    continue;
                }

                this.reportSuccess(node, performance.now() - start);
                return resp;
            } catch (err) {
                clearTimeout(timeout);
                const errorName = String((err as any)?.name || "");
                this.reportFailure(node, errorName === "AbortError" ? 408 : undefined);
                lastError = err as Error;
            }
        }

        throw lastError || new Error("No healthy proxy available");
    }

    async fetch(
        url: string,
        init?: RequestInit,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        proxyParams?: Record<string, string | number | boolean | undefined>
    ): Promise<Response> {
        if (this.shouldDedupeRequest(url, init)) {
            const dedupeKey = this.buildDedupeKey(url, proxyParams);
            const existing = this.inFlightManifestRequests.get(dedupeKey);

            if (existing) {
                const shared = await existing;
                return shared.clone();
            }

            const task = this.fetchInternal(url, init, timeoutMs, proxyParams);
            this.inFlightManifestRequests.set(dedupeKey, task);

            try {
                const response = await task;
                return response.clone();
            } finally {
                this.inFlightManifestRequests.delete(dedupeKey);
            }
        }

        return this.fetchInternal(url, init, timeoutMs, proxyParams);
    }
}
