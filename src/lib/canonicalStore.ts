import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { log, logRateLimited } from "../config/logger.js";

export type CanonicalScope = "anime" | "manga" | "hianime";

type JsonRecord = Record<string, unknown>;

type SnapshotEnvelopeInput = {
  key: string;
  scope: CanonicalScope;
  routePath: string;
  queryString: string;
  statusCode: number;
  projection: JsonRecord;
  payload: unknown;
  responseHeaders: JsonRecord;
  sourceMode: string;
  refreshedAt: string;
  expiresAt: string | null;
};

type DailyMangaHomeInput = {
  dayKey: string;
  provider: string;
  payload: unknown;
  projection: JsonRecord;
  sourceSnapshotKey: string | null;
};

export type DailyMangaHomeRecord = {
  dayKey: string;
  provider: string;
  payload: unknown;
  projection: JsonRecord;
  sourceSnapshotKey: string | null;
  refreshedAt: string;
};

export type SourceValidationCandidate = {
  scope: CanonicalScope;
  provider: string | null;
  anilistId: number | null;
  malId: number | null;
  mediaKind: "source" | "subtitle" | "image";
  sourceUrl: string;
  metadata: JsonRecord;
};

export type ReservedSourceValidationRow = {
  id: number;
  sourceHash: string;
  sourceUrl: string;
  scope: CanonicalScope;
  provider: string | null;
  mediaKind: "source" | "subtitle" | "image";
  failCount: number;
  successCount: number;
};

export type CanonicalOperationalSummary = {
  snapshotTotal: number;
  snapshotByScope: Array<{ scope: CanonicalScope; count: number }>;
  sourceQueue: {
    total: number;
    pending: number;
    healthy: number;
    unhealthy: number;
    due: number;
  };
  mangaHomeRows: number;
  recentSnapshots: Array<{
    scope: CanonicalScope;
    routePath: string;
    refreshedAt: string;
  }>;
  recentJobs: Array<{
    jobName: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
};

const parseJsonField = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return fallback;
};

const canonicalSourceHash = (scope: CanonicalScope, mediaKind: string, sourceUrl: string) => {
  return createHash("sha1")
    .update(`${scope}:${mediaKind}:${sourceUrl}`)
    .digest("hex");
};

const toIsoDate = (value: Date = new Date()) => value.toISOString().slice(0, 10);

class CanonicalStore {
  private static instance: CanonicalStore | null = null;

  private readonly enabled: boolean;
  private readonly pool: Pool | null;
  private readonly connectTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly outageBackoffMs: number;
  private dbBackoffUntil = 0;

  private constructor() {
    const enabledFlag = String(process.env.TATAKAI_CANONICAL_DB_ENABLED || "true").toLowerCase();
    const connectionString =
      process.env.TATAKAI_CANONICAL_DB_URL ||
      process.env.DATABASE_URL ||
      "";

    const parsedConnectTimeout = Number.parseInt(
      String(process.env.TATAKAI_CANONICAL_DB_CONNECT_TIMEOUT_MS || "700"),
      10
    );
    const parsedQueryTimeout = Number.parseInt(
      String(process.env.TATAKAI_CANONICAL_DB_QUERY_TIMEOUT_MS || "1000"),
      10
    );
    const parsedBackoffMs = Number.parseInt(
      String(process.env.TATAKAI_CANONICAL_DB_OUTAGE_BACKOFF_MS || "60000"),
      10
    );

    this.connectTimeoutMs = Number.isFinite(parsedConnectTimeout)
      ? Math.max(250, Math.min(parsedConnectTimeout, 15_000))
      : 700;
    this.queryTimeoutMs = Number.isFinite(parsedQueryTimeout)
      ? Math.max(500, Math.min(parsedQueryTimeout, 20_000))
      : 1000;
    this.outageBackoffMs = Number.isFinite(parsedBackoffMs)
      ? Math.max(5_000, Math.min(parsedBackoffMs, 5 * 60_000))
      : 60_000;

    this.enabled = Boolean(connectionString) && enabledFlag !== "false" && enabledFlag !== "0";

    if (!this.enabled) {
      this.pool = null;
      return;
    }

    this.pool = new Pool({
      connectionString,
      max: Number.parseInt(String(process.env.TATAKAI_CANONICAL_DB_POOL_MAX || "8"), 10) || 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: this.connectTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
      allowExitOnIdle: false,
    });

    this.pool.on("error", (error) => {
      this.markDbBackoff(error);
      logRateLimited("canonical-store:pool-error", () => {
        log.warn(
          { error: (error as Error)?.message || String(error) },
          "canonical store pool error"
        );
      }, 15_000);
    });

    log.info(
      {
        connectTimeoutMs: this.connectTimeoutMs,
        queryTimeoutMs: this.queryTimeoutMs,
        outageBackoffMs: this.outageBackoffMs,
      },
      "canonical store enabled (postgres)"
    );
  }

  static getInstance() {
    if (!CanonicalStore.instance) {
      CanonicalStore.instance = new CanonicalStore();
    }

    return CanonicalStore.instance;
  }

  isEnabled() {
    return this.enabled;
  }

  private isDbBackoffActive() {
    return Date.now() < this.dbBackoffUntil;
  }

  private getDbErrorMessage(error: unknown) {
    const fragments: string[] = [];
    const visited = new Set<unknown>();

    const collect = (value: unknown) => {
      if (value === null || value === undefined) return;
      if (visited.has(value)) return;

      if (typeof value === "string") {
        fragments.push(value);
        return;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        fragments.push(String(value));
        return;
      }

      if (value instanceof Error) {
        visited.add(value);
        if (value.name) fragments.push(value.name);
        if (value.message) fragments.push(value.message);

        const asAny = value as any;
        if (typeof asAny.code === "string" && asAny.code) {
          fragments.push(asAny.code);
        }

        if (asAny.cause) {
          collect(asAny.cause);
        }

        if (Array.isArray(asAny.errors)) {
          for (const nested of asAny.errors) {
            collect(nested);
          }
        }

        return;
      }

      try {
        fragments.push(String(value));
      } catch {
        // Ignore non-stringifiable values.
      }
    };

    collect(error);
    return fragments.join(" | ").toLowerCase();
  }

  private isDbUnavailableMessage(message: string) {
    return (
      message.includes("connection terminated due to connection timeout") ||
      message.includes("timeout") ||
      message.includes("connection terminated unexpectedly") ||
      message.includes("server closed the connection unexpectedly") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("enotfound") ||
      message.includes("could not connect") ||
      message.includes("connection reset") ||
      message.includes("the database system is starting up")
    );
  }

  private markDbBackoff(error: unknown) {
    const message = this.getDbErrorMessage(error);
    if (!this.isDbUnavailableMessage(message)) return;
    this.dbBackoffUntil = Date.now() + this.outageBackoffMs;
  }

  private async withClient<T>(task: (client: PoolClient) => Promise<T>) {
    if (!this.enabled || !this.pool) return null;
    if (this.isDbBackoffActive()) return null;

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      return await task(client);
    } catch (error) {
      const message = this.getDbErrorMessage(error);
      this.markDbBackoff(error);

      if (this.isDbUnavailableMessage(message)) {
        logRateLimited("canonical-store:db-unavailable", () => {
          log.debug(
            { error: message, backoffUntil: this.dbBackoffUntil },
            "canonical store unavailable; skipping db operation"
          );
        }, 30_000);
        return null;
      }

      throw error;
    } finally {
      client?.release();
    }
  }

  async upsertSnapshot(input: SnapshotEnvelopeInput) {
    return this.withClient(async (client) => {
      await client.query(
        `
          insert into public.api_canonical_snapshots (
            snapshot_key,
            scope,
            route_path,
            query_string,
            status_code,
            projection,
            payload,
            response_headers,
            source_mode,
            refreshed_at,
            expires_at,
            created_at,
            updated_at
          )
          values (
            $1, $2, $3, $4, $5,
            $6::jsonb,
            $7::jsonb,
            $8::jsonb,
            $9,
            $10::timestamptz,
            $11::timestamptz,
            now(),
            now()
          )
          on conflict (snapshot_key)
          do update set
            scope = excluded.scope,
            route_path = excluded.route_path,
            query_string = excluded.query_string,
            status_code = excluded.status_code,
            projection = excluded.projection,
            payload = excluded.payload,
            response_headers = excluded.response_headers,
            source_mode = excluded.source_mode,
            refreshed_at = excluded.refreshed_at,
            expires_at = excluded.expires_at,
            updated_at = now()
        `,
        [
          input.key,
          input.scope,
          input.routePath,
          input.queryString,
          input.statusCode,
          JSON.stringify(input.projection || {}),
          JSON.stringify(input.payload ?? null),
          JSON.stringify(input.responseHeaders || {}),
          input.sourceMode,
          input.refreshedAt,
          input.expiresAt,
        ]
      );
    });
  }

  async getSnapshotByKey(key: string) {
    const row = await this.withClient(async (client) => {
      const result = await client.query(
        `
          select
            snapshot_key,
            scope,
            route_path,
            query_string,
            status_code,
            projection,
            payload,
            response_headers,
            source_mode,
            refreshed_at,
            expires_at
          from public.api_canonical_snapshots
          where snapshot_key = $1
          limit 1
        `,
        [key]
      );
      return result.rows[0] || null;
    });

    if (!row) return null;

    return {
      key: String(row.snapshot_key),
      scope: String(row.scope) as CanonicalScope,
      routePath: String(row.route_path),
      queryString: String(row.query_string || ""),
      statusCode: Number(row.status_code || 200),
      projection: parseJsonField<JsonRecord>(row.projection, {}),
      payload: parseJsonField<unknown>(row.payload, null),
      responseHeaders: parseJsonField<JsonRecord>(row.response_headers, {}),
      sourceMode: String(row.source_mode || "live"),
      refreshedAt: new Date(row.refreshed_at || Date.now()).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }

  async deleteSnapshotByKey(key: string) {
    return this.withClient(async (client) => {
      await client.query(
        `
          delete from public.api_canonical_snapshots
          where snapshot_key = $1
        `,
        [key]
      );
    });
  }

  async getLatestSnapshotByRoute(scope: CanonicalScope, routePath: string, queryString = "") {
    const row = await this.withClient(async (client) => {
      const result = await client.query(
        `
          select
            snapshot_key,
            scope,
            route_path,
            query_string,
            status_code,
            projection,
            payload,
            response_headers,
            source_mode,
            refreshed_at,
            expires_at
          from public.api_canonical_snapshots
          where scope = $1
            and route_path = $2
            and query_string = $3
          order by refreshed_at desc
          limit 1
        `,
        [scope, routePath, queryString]
      );
      return result.rows[0] || null;
    });

    if (!row) return null;

    return {
      key: String(row.snapshot_key),
      scope: String(row.scope) as CanonicalScope,
      routePath: String(row.route_path),
      queryString: String(row.query_string || ""),
      statusCode: Number(row.status_code || 200),
      projection: parseJsonField<JsonRecord>(row.projection, {}),
      payload: parseJsonField<unknown>(row.payload, null),
      responseHeaders: parseJsonField<JsonRecord>(row.response_headers, {}),
      sourceMode: String(row.source_mode || "live"),
      refreshedAt: new Date(row.refreshed_at || Date.now()).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }

  async upsertDailyMangaHome(input: DailyMangaHomeInput) {
    return this.withClient(async (client) => {
      await client.query(
        `
          insert into public.api_manga_home_daily (
            day_key,
            provider,
            payload,
            projection,
            source_snapshot_key,
            refreshed_at,
            created_at,
            updated_at
          )
          values (
            $1::date,
            $2,
            $3::jsonb,
            $4::jsonb,
            $5,
            now(),
            now(),
            now()
          )
          on conflict (day_key, provider)
          do update set
            payload = excluded.payload,
            projection = excluded.projection,
            source_snapshot_key = excluded.source_snapshot_key,
            refreshed_at = now(),
            updated_at = now()
        `,
        [
          input.dayKey,
          input.provider,
          JSON.stringify(input.payload ?? null),
          JSON.stringify(input.projection || {}),
          input.sourceSnapshotKey,
        ]
      );
    });
  }

  async getDailyMangaHome(dayKey?: string, providers?: string[]): Promise<DailyMangaHomeRecord[]> {
    const targetDay = dayKey || toIsoDate();
    const normalizedProviders = (providers || []).map((provider) => provider.trim().toLowerCase()).filter(Boolean);

    const rows = await this.withClient(async (client) => {
      if (normalizedProviders.length === 0) {
        const result = await client.query(
          `
            select
              day_key,
              provider,
              payload,
              projection,
              source_snapshot_key,
              refreshed_at
            from public.api_manga_home_daily
            where day_key = $1::date
            order by provider asc
          `,
          [targetDay]
        );
        return result.rows;
      }

      const result = await client.query(
        `
          select
            day_key,
            provider,
            payload,
            projection,
            source_snapshot_key,
            refreshed_at
          from public.api_manga_home_daily
          where day_key = $1::date
            and provider = any($2::text[])
          order by provider asc
        `,
        [targetDay, normalizedProviders]
      );
      return result.rows;
    });

    if (!rows) return [];

    return rows.map((row) => ({
      dayKey: new Date(row.day_key).toISOString().slice(0, 10),
      provider: String(row.provider),
      payload: parseJsonField<unknown>(row.payload, null),
      projection: parseJsonField<JsonRecord>(row.projection, {}),
      sourceSnapshotKey: row.source_snapshot_key ? String(row.source_snapshot_key) : null,
      refreshedAt: new Date(row.refreshed_at || Date.now()).toISOString(),
    }));
  }

  async enqueueSourceCandidates(candidates: SourceValidationCandidate[]) {
    if (!candidates.length) return null;

    return this.withClient(async (client) => {
      for (const candidate of candidates) {
        const sourceUrl = String(candidate.sourceUrl || "").trim();
        if (!sourceUrl) continue;

        const sourceHash = canonicalSourceHash(candidate.scope, candidate.mediaKind, sourceUrl);

        await client.query(
          `
            insert into public.api_source_validation_queue (
              source_hash,
              source_url,
              scope,
              provider,
              anilist_id,
              mal_id,
              media_kind,
              status,
              discovered_at,
              next_check_at,
              metadata
            )
            values (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'pending',
              now(),
              now(),
              $8::jsonb
            )
            on conflict (source_hash)
            do update set
              provider = excluded.provider,
              anilist_id = coalesce(excluded.anilist_id, public.api_source_validation_queue.anilist_id),
              mal_id = coalesce(excluded.mal_id, public.api_source_validation_queue.mal_id),
              metadata = public.api_source_validation_queue.metadata || excluded.metadata,
              updated_at = now()
          `,
          [
            sourceHash,
            sourceUrl,
            candidate.scope,
            candidate.provider,
            candidate.anilistId,
            candidate.malId,
            candidate.mediaKind,
            JSON.stringify(candidate.metadata || {}),
          ]
        ).catch(async (error) => {
          // Compatibility path for installations that have not run migration yet.
          if (!String(error?.message || "").toLowerCase().includes("updated_at")) {
            throw error;
          }

          await client.query(
            `
              insert into public.api_source_validation_queue (
                source_hash,
                source_url,
                scope,
                provider,
                anilist_id,
                mal_id,
                media_kind,
                status,
                discovered_at,
                next_check_at,
                metadata
              )
              values (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                'pending',
                now(),
                now(),
                $8::jsonb
              )
              on conflict (source_hash)
              do update set
                provider = excluded.provider,
                anilist_id = coalesce(excluded.anilist_id, public.api_source_validation_queue.anilist_id),
                mal_id = coalesce(excluded.mal_id, public.api_source_validation_queue.mal_id),
                metadata = public.api_source_validation_queue.metadata || excluded.metadata
            `,
            [
              sourceHash,
              sourceUrl,
              candidate.scope,
              candidate.provider,
              candidate.anilistId,
              candidate.malId,
              candidate.mediaKind,
              JSON.stringify(candidate.metadata || {}),
            ]
          );
        });
      }
    });
  }

  async reserveSourceValidationBatch(limit: number): Promise<ReservedSourceValidationRow[]> {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

    const rows = await this.withClient(async (client) => {
      const result = await client.query(
        `
          with due as (
            select id
            from public.api_source_validation_queue
            where next_check_at <= now()
            order by random()
            limit $1
            for update skip locked
          )
          update public.api_source_validation_queue q
          set
            next_check_at = now() + interval '10 minutes',
            metadata = coalesce(q.metadata, '{}'::jsonb) || jsonb_build_object('reservedAt', now())
          from due
          where q.id = due.id
          returning
            q.id,
            q.source_hash,
            q.source_url,
            q.scope,
            q.provider,
            q.media_kind,
            q.fail_count,
            q.success_count
        `,
        [boundedLimit]
      );
      return result.rows;
    });

    if (!rows) return [];

    return rows.map((row) => ({
      id: Number(row.id),
      sourceHash: String(row.source_hash),
      sourceUrl: String(row.source_url),
      scope: String(row.scope) as CanonicalScope,
      provider: row.provider ? String(row.provider) : null,
      mediaKind: String(row.media_kind) as "source" | "subtitle" | "image",
      failCount: Number(row.fail_count || 0),
      successCount: Number(row.success_count || 0),
    }));
  }

  async completeSourceValidation(
    id: number,
    result: {
      ok: boolean;
      httpStatus: number | null;
      error: string | null;
      nextCheckMinutes: number;
    }
  ) {
    return this.withClient(async (client) => {
      await client.query(
        `
          update public.api_source_validation_queue
          set
            status = $2,
            fail_count = case when $2 = 'unhealthy' then fail_count + 1 else fail_count end,
            success_count = case when $2 = 'healthy' then success_count + 1 else success_count end,
            last_checked_at = now(),
            next_check_at = now() + ($3::text || ' minutes')::interval,
            last_http_status = $4,
            last_error = $5,
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('lastCheckedAt', now())
          where id = $1
        `,
        [
          id,
          result.ok ? "healthy" : "unhealthy",
          Math.max(1, Math.min(result.nextCheckMinutes, 24 * 60)).toString(),
          result.httpStatus,
          result.error,
        ]
      );
    });
  }

  async startJobRun(jobName: string) {
    const runToken = randomUUID();

    await this.withClient(async (client) => {
      await client.query(
        `
          insert into public.api_job_runs (
            job_name,
            run_token,
            status,
            started_at,
            stats
          )
          values ($1, $2, 'running', now(), '{}'::jsonb)
        `,
        [jobName, runToken]
      );
    });

    return runToken;
  }

  async finishJobRun(runToken: string, status: "success" | "failed", stats: JsonRecord, errorMessage: string | null) {
    return this.withClient(async (client) => {
      await client.query(
        `
          update public.api_job_runs
          set
            status = $2,
            finished_at = now(),
            stats = $3::jsonb,
            error_message = $4
          where run_token = $1
        `,
        [runToken, status, JSON.stringify(stats || {}), errorMessage]
      );
    });
  }

  async getOperationalSummary(options?: { recentLimit?: number }): Promise<CanonicalOperationalSummary | null> {
    const recentLimit = Math.max(1, Math.min(Number(options?.recentLimit) || 10, 50));

    const data = await this.withClient(async (client) => {
      const snapshotTotalResult = await client.query(
        `select count(*)::int as count from public.api_canonical_snapshots`
      );
      const snapshotByScopeResult = await client.query(
        `
          select scope, count(*)::int as count
          from public.api_canonical_snapshots
          group by scope
        `
      );
      const queueByStatusResult = await client.query(
        `
          select status, count(*)::int as count
          from public.api_source_validation_queue
          group by status
        `
      );
      const queueDueResult = await client.query(
        `
          select count(*)::int as count
          from public.api_source_validation_queue
          where next_check_at <= now()
        `
      );
      const mangaHomeResult = await client.query(
        `select count(*)::int as count from public.api_manga_home_daily`
      );
      const recentSnapshotsResult = await client.query(
        `
          select scope, route_path, refreshed_at
          from public.api_canonical_snapshots
          order by refreshed_at desc
          limit $1
        `,
        [recentLimit]
      );
      const recentJobsResult = await client.query(
        `
          select job_name, status, started_at, finished_at
          from public.api_job_runs
          order by started_at desc
          limit $1
        `,
        [recentLimit]
      );

      return {
        snapshotTotal: Number(snapshotTotalResult.rows[0]?.count || 0),
        snapshotByScope: snapshotByScopeResult.rows.map((row) => ({
          scope: String(row.scope) as CanonicalScope,
          count: Number(row.count || 0),
        })),
        queueByStatus: queueByStatusResult.rows,
        queueDue: Number(queueDueResult.rows[0]?.count || 0),
        mangaHomeRows: Number(mangaHomeResult.rows[0]?.count || 0),
        recentSnapshots: recentSnapshotsResult.rows,
        recentJobs: recentJobsResult.rows,
      };
    });

    if (!data) return null;

    const queueCounts = new Map<string, number>();
    for (const row of data.queueByStatus) {
      queueCounts.set(String(row.status), Number(row.count || 0));
    }

    return {
      snapshotTotal: data.snapshotTotal,
      snapshotByScope: data.snapshotByScope,
      sourceQueue: {
        total:
          (queueCounts.get("pending") || 0) +
          (queueCounts.get("healthy") || 0) +
          (queueCounts.get("unhealthy") || 0),
        pending: queueCounts.get("pending") || 0,
        healthy: queueCounts.get("healthy") || 0,
        unhealthy: queueCounts.get("unhealthy") || 0,
        due: data.queueDue,
      },
      mangaHomeRows: data.mangaHomeRows,
      recentSnapshots: data.recentSnapshots.map((row) => ({
        scope: String(row.scope) as CanonicalScope,
        routePath: String(row.route_path || ""),
        refreshedAt: new Date(row.refreshed_at || Date.now()).toISOString(),
      })),
      recentJobs: data.recentJobs.map((row) => ({
        jobName: String(row.job_name || ""),
        status: String(row.status || ""),
        startedAt: new Date(row.started_at || Date.now()).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      })),
    };
  }
}

export const canonicalStore = CanonicalStore.getInstance();
