import { canonicalStore } from "../lib/canonicalStore.js";
import { log, logRateLimited } from "../config/logger.js";

const DEFAULT_MANGA_HOME_PROVIDERS = ["mangaball", "allmanga", "atsu", "mangafire"] as const;

const toBoundedInt = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const randomWithin = (min: number, max: number) => {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const isTruthyFlag = (value: string | undefined, fallback = true) => {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "off";
};

const runSafely = async <T>(label: string, task: () => Promise<T>) => {
  try {
    return await task();
  } catch (error: any) {
    logRateLimited(`canonical-jobs:${label}:error`, () => {
      log.warn({ error: error?.message || String(error) }, `canonical job failed: ${label}`);
    }, 15_000);
    return null;
  }
};

export const refreshMangaDailyHomeSnapshots = async (options: {
  origin: string;
  providers?: string[];
  timeoutMs?: number;
}) => {
  const providers = (options.providers || [...DEFAULT_MANGA_HOME_PROVIDERS])
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);

  const timeoutMs = Math.max(2000, Math.min(Number(options.timeoutMs || 20000), 45_000));
  const startedAt = Date.now();
  const stats = {
    total: providers.length,
    ok: 0,
    failed: 0,
    results: [] as Array<{ provider: string; ok: boolean; status: number; durationMs: number; message?: string }> ,
  };

  let runToken: string | null = null;
  if (canonicalStore.isEnabled()) {
    runToken = await runSafely("manga-home-refresh:start", () => canonicalStore.startJobRun("manga-home-daily-refresh"));
  }

  for (const provider of providers) {
    const requestStartedAt = Date.now();
    const url = new URL(`/api/v2/manga/${provider}/home`, options.origin);
    url.searchParams.set("snapshotRefresh", "1");
    url.searchParams.set("snapshotUse", "0");

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });

      const durationMs = Date.now() - requestStartedAt;
      const ok = response.ok;
      if (ok) stats.ok += 1;
      else stats.failed += 1;

      stats.results.push({
        provider,
        ok,
        status: response.status,
        durationMs,
        message: ok ? undefined : `refresh returned status ${response.status}`,
      });
    } catch (error: any) {
      const durationMs = Date.now() - requestStartedAt;
      stats.failed += 1;
      stats.results.push({
        provider,
        ok: false,
        status: 0,
        durationMs,
        message: error?.message || "refresh failed",
      });
    }
  }

  const finishedStats = {
    ...stats,
    durationMs: Date.now() - startedAt,
  };

  if (runToken) {
    await runSafely("manga-home-refresh:finish", () =>
      canonicalStore.finishJobRun(
        runToken as string,
        finishedStats.failed > 0 ? "failed" : "success",
        finishedStats,
        finishedStats.failed > 0 ? "one or more providers failed" : null
      )
    );
  }

  return finishedStats;
};

const probeSourceUrl = async (sourceUrl: string, timeoutMs: number) => {
  const normalizedUrl = String(sourceUrl || "").trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return {
      ok: false,
      status: null as number | null,
      error: "invalid-url",
    };
  }

  try {
    const headResponse = await fetch(normalizedUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "*/*",
      },
    });

    if (headResponse.status >= 200 && headResponse.status < 400) {
      return { ok: true, status: headResponse.status, error: null as string | null };
    }

    if ([403, 405, 406, 429].includes(headResponse.status)) {
      const getResponse = await fetch(normalizedUrl, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "*/*",
          Range: "bytes=0-1023",
        },
      });

      if (getResponse.status >= 200 && getResponse.status < 400) {
        return { ok: true, status: getResponse.status, error: null as string | null };
      }

      return {
        ok: false,
        status: getResponse.status,
        error: `probe-status-${getResponse.status}`,
      };
    }

    return {
      ok: false,
      status: headResponse.status,
      error: `probe-status-${headResponse.status}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: null,
      error: error?.message || "probe-failed",
    };
  }
};

export const runRandomSourceValidationSample = async (options?: {
  limit?: number;
  timeoutMs?: number;
}) => {
  if (!canonicalStore.isEnabled()) {
    return {
      enabled: false,
      reserved: 0,
      checked: 0,
      healthy: 0,
      unhealthy: 0,
      results: [] as Array<{ id: number; ok: boolean; status: number | null; error: string | null }> ,
    };
  }

  const limit = toBoundedInt(String(options?.limit || ""), 10, 1, 50);
  const timeoutMs = Math.max(1500, Math.min(Number(options?.timeoutMs || 9000), 20_000));

  const runToken = await runSafely("source-validation:start", () => canonicalStore.startJobRun("source-validation-random"));
  const batch = (await runSafely("source-validation:reserve", () => canonicalStore.reserveSourceValidationBatch(limit))) || [];

  const results: Array<{ id: number; ok: boolean; status: number | null; error: string | null }> = [];

  let healthy = 0;
  let unhealthy = 0;

  for (const row of batch) {
    const probe = await probeSourceUrl(row.sourceUrl, timeoutMs);
    const nextCheckMinutes = probe.ok ? randomWithin(6 * 60, 12 * 60) : randomWithin(30, 120);

    await runSafely("source-validation:complete", () =>
      canonicalStore.completeSourceValidation(row.id, {
        ok: probe.ok,
        httpStatus: probe.status,
        error: probe.error,
        nextCheckMinutes,
      })
    );

    if (probe.ok) healthy += 1;
    else unhealthy += 1;

    results.push({
      id: row.id,
      ok: probe.ok,
      status: probe.status,
      error: probe.error,
    });
  }

  const summary = {
    enabled: true,
    reserved: batch.length,
    checked: results.length,
    healthy,
    unhealthy,
    results,
  };

  if (runToken) {
    await runSafely("source-validation:finish", () =>
      canonicalStore.finishJobRun(
        runToken,
        unhealthy > 0 ? "failed" : "success",
        summary,
        unhealthy > 0 ? "one or more source checks failed" : null
      )
    );
  }

  return summary;
};

let schedulerStarted = false;
let lastMangaHomeRefreshDay = "";

export const startCanonicalBackgroundJobs = (origin: string) => {
  if (schedulerStarted) return;

  let schedulerOrigin = "";
  try {
    schedulerOrigin = new URL(origin).origin;
  } catch (error: any) {
    log.warn(
      {
        origin,
        error: error?.message || String(error),
      },
      "canonical background jobs disabled due to invalid origin"
    );
    return;
  }

  schedulerStarted = true;

  const sourceCheckEnabled = isTruthyFlag(process.env.TATAKAI_SOURCE_VALIDATION_ENABLED, true);
  const sourceCheckEveryMs = toBoundedInt(process.env.TATAKAI_SOURCE_VALIDATION_INTERVAL_MS, 15 * 60 * 1000, 60_000, 60 * 60 * 1000);
  const sourceCheckBatch = toBoundedInt(process.env.TATAKAI_SOURCE_VALIDATION_BATCH, 8, 1, 30);

  const dailyHomeEnabled = isTruthyFlag(process.env.TATAKAI_MANGA_HOME_REFRESH_ENABLED, true);
  const dailyHomeTickMs = toBoundedInt(process.env.TATAKAI_MANGA_HOME_REFRESH_TICK_MS, 30 * 60 * 1000, 60_000, 2 * 60 * 60 * 1000);

  if (dailyHomeEnabled) {
    const maybeRefreshDaily = async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        if (today === lastMangaHomeRefreshDay) return;

        const result = await refreshMangaDailyHomeSnapshots({ origin: schedulerOrigin });
        if (result.ok > 0) {
          lastMangaHomeRefreshDay = today;
        }
      } catch (error: any) {
        logRateLimited("canonical-jobs:manga-home-refresh:uncaught", () => {
          log.warn({ error: error?.message || String(error) }, "manga home refresh scheduler failed");
        }, 15_000);
      }
    };

    void maybeRefreshDaily();
    setInterval(() => {
      void maybeRefreshDaily();
    }, dailyHomeTickMs);
  }

  if (sourceCheckEnabled) {
    const runSample = async () => {
      try {
        await runRandomSourceValidationSample({ limit: sourceCheckBatch });
      } catch (error: any) {
        logRateLimited("canonical-jobs:source-validation:uncaught", () => {
          log.warn({ error: error?.message || String(error) }, "source validation scheduler failed");
        }, 15_000);
      }
    };

    void runSample();
    setInterval(() => {
      void runSample();
    }, sourceCheckEveryMs);
  }

  log.info({ sourceCheckEnabled, dailyHomeEnabled }, "canonical background jobs started");
};
