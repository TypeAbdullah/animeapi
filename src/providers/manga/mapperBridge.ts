import { fetchLocalMapperChapters, fetchLocalMapperPages } from "./localMapper.js";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const MANGA_MAPPER_PROVIDERS = [
  "mangadex",
  "asurascans",
  "mangapark",
  "mangabuddy",
  "mangakakalot",
  "mangaball",
  "allmanga",
  "atsu",
  "mangafire",
] as const;

export type MangaMapperProvider = (typeof MANGA_MAPPER_PROVIDERS)[number];

export interface MapperChapter {
  id: string;
  title?: string;
  number?: number | string;
  volume?: number | string;
  url?: string;
  date?: string;
  language?: string;
  scanlator?: string;
  providerMangaId?: string;
}

export interface MapperPage {
  url: string;
  index?: number;
  width?: number;
  height?: number;
}

export interface MapperFetchResult<T> {
  provider: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  data: T;
  error?: string;
}

const resolveDefaultMapperBaseUrl = () => {
  const rawHostname = String(process.env.ANIWATCH_API_HOSTNAME || "").trim();
  const hostname = rawHostname.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");

  const origin = hostname.length > 0
    ? `https://${hostname}`
    : `https://api.tatakai.me:${String(process.env.ANIWATCH_API_PORT || 4000).trim()}`;

  return `${origin}/api/v2/manga`;
};

const MANGA_MAPPER_DEFAULT_BASE_URL = resolveDefaultMapperBaseUrl();
const MANGA_MAPPER_DEFAULT_TIMEOUT_MS = 8000;
const MANGA_MAPPER_CACHE_DIR = String(process.env.MANGA_MAPPER_CACHE_DIR || "").trim() ||
  path.join(os.tmpdir(), "tatakaiapi", "manga-mapper-cache");
const MANGA_MAPPER_CACHE_TTL_MS = Number.parseInt(String(process.env.MANGA_MAPPER_CACHE_TTL_MS || 1000 * 60 * 60 * 6), 10);
const MANGA_MAPPER_CACHE_STALE_MS = Number.parseInt(String(process.env.MANGA_MAPPER_CACHE_STALE_MS || 1000 * 60 * 60 * 24 * 3), 10);

const now = () => Date.now();
const memoryMapperCache = new Map<string, PersistedMapperCacheEntry>();

type PersistedMapperCacheEntry = {
  version: 1;
  key: string;
  path: string;
  payload: unknown;
  status: number;
  savedAt: number;
  expiresAt: number;
  staleUntil: number;
};

const asPositive = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
};

const MAPPER_CACHE_TTL_MS = asPositive(MANGA_MAPPER_CACHE_TTL_MS, 1000 * 60 * 60 * 6);
const MAPPER_CACHE_STALE_MS = Math.max(MAPPER_CACHE_TTL_MS, asPositive(MANGA_MAPPER_CACHE_STALE_MS, 1000 * 60 * 60 * 24 * 3));

const toCacheFilePath = (requestPath: string) => {
  const digest = createHash("sha1").update(requestPath).digest("hex");
  return path.join(MANGA_MAPPER_CACHE_DIR, `${digest}.json`);
};

const readPersistedMapperCache = async (requestPath: string): Promise<PersistedMapperCacheEntry | null> => {
  const inMemory = memoryMapperCache.get(requestPath);
  if (inMemory) return inMemory;

  try {
    const cachePath = toCacheFilePath(requestPath);
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedMapperCacheEntry;
    if (!parsed || parsed.version !== 1 || parsed.path !== requestPath) return null;
    memoryMapperCache.set(requestPath, parsed);
    return parsed;
  } catch {
    return null;
  }
};

const persistMapperCache = async (requestPath: string, status: number, payload: unknown) => {
  const savedAt = now();
  const entry: PersistedMapperCacheEntry = {
    version: 1,
    key: createHash("sha1").update(requestPath).digest("hex"),
    path: requestPath,
    payload,
    status,
    savedAt,
    expiresAt: savedAt + MAPPER_CACHE_TTL_MS,
    staleUntil: savedAt + MAPPER_CACHE_STALE_MS,
  };

  memoryMapperCache.set(requestPath, entry);

  try {
    await mkdir(MANGA_MAPPER_CACHE_DIR, { recursive: true });
    const cachePath = toCacheFilePath(requestPath);
    await writeFile(cachePath, JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort disk persistence; mapper flow should continue even when writes fail.
  }
};

const readBaseUrl = () => {
  return String(process.env.MANGA_MAPPER_BASE_URL || MANGA_MAPPER_DEFAULT_BASE_URL).replace(/\/+$/, "");
};

const readTimeoutMs = () => {
  const parsed = Number.parseInt(String(process.env.MANGA_MAPPER_TIMEOUT_MS || MANGA_MAPPER_DEFAULT_TIMEOUT_MS), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MANGA_MAPPER_DEFAULT_TIMEOUT_MS;
  return parsed;
};

const parseJsonSafely = async (response: Response): Promise<any> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const extractChapterRows = (payload: any, provider: string): MapperChapter[] => {
  const direct = Array.isArray(payload?.chapters)
    ? payload.chapters
    : Array.isArray(payload?.[provider]?.chapters)
      ? payload[provider].chapters
      : Array.isArray(payload?.data?.chapters)
        ? payload.data.chapters
        : Array.isArray(payload?.data)
          ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

  const chapters: MapperChapter[] = direct
    .map((chapter: any): MapperChapter => ({
      id: String(chapter?.id || chapter?.chapterId || ""),
      title: chapter?.title ? String(chapter.title) : undefined,
      number: chapter?.number ?? chapter?.chapter ?? chapter?.chapterNumber,
      volume: chapter?.volume,
      url: chapter?.url ? String(chapter.url) : undefined,
      date: chapter?.date ? String(chapter.date) : undefined,
      language: chapter?.language ? String(chapter.language) : undefined,
      scanlator: chapter?.scanlator ? String(chapter.scanlator) : undefined,
      providerMangaId: chapter?.providerMangaId ? String(chapter.providerMangaId) : undefined,
    }));

  return chapters.filter((chapter: MapperChapter) => chapter.id.length > 0);
};

const extractPageRows = (payload: any): MapperPage[] => {
  const direct = Array.isArray(payload?.pages)
    ? payload.pages
    : Array.isArray(payload?.data?.pages)
      ? payload.data.pages
      : Array.isArray(payload?.data)
        ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

  const pages: MapperPage[] = direct
    .map((page: any, index: number): MapperPage => ({
      url: String(page?.url || page?.image || page?.img || ""),
      index: Number.isFinite(Number(page?.index)) ? Number(page.index) : index,
      width: Number.isFinite(Number(page?.width)) ? Number(page.width) : undefined,
      height: Number.isFinite(Number(page?.height)) ? Number(page.height) : undefined,
    }));

  return pages.filter((page: MapperPage) => page.url.length > 0);
};

const fetchMapperPath = async (path: string) => {
  const start = now();
  const baseUrl = readBaseUrl();
  const timeoutMs = readTimeoutMs();
  const cached = await readPersistedMapperCache(path);

  if (cached && now() <= cached.expiresAt) {
    return {
      ok: cached.status >= 200 && cached.status < 300,
      status: cached.status,
      latencyMs: 0,
      payload: cached.payload,
      error: undefined,
      source: "cache",
    };
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await parseJsonSafely(response);
    if (response.ok && payload !== null) {
      void persistMapperCache(path, response.status, payload);
    }

    return {
      ok: response.ok,
      status: response.status,
      latencyMs: now() - start,
      payload,
      error: response.ok
        ? undefined
        : String(payload?.message || payload?.error || `Mapper request failed with ${response.status}`),
      source: "network",
    };
  } catch (error: any) {
    if (cached && now() <= cached.staleUntil) {
      return {
        ok: cached.status >= 200 && cached.status < 300,
        status: cached.status,
        latencyMs: now() - start,
        payload: cached.payload,
        error: undefined,
        source: "stale-cache",
      };
    }

    return {
      ok: false,
      status: 503,
      latencyMs: now() - start,
      payload: null,
      error: error?.message || "Mapper request failed",
      source: "network-error",
    };
  }
};

export const fetchMapperChapters = async (
  provider: string,
  anilistId: number,
  language?: string
): Promise<MapperFetchResult<MapperChapter[]>> => {
  const safeProvider = provider.toLowerCase();
  const local = await fetchLocalMapperChapters(safeProvider, anilistId, language);
  if (local) {
    return local;
  }

  const normalizedLanguage = String(language || "").trim();
  const query = normalizedLanguage ? `?lang=${encodeURIComponent(normalizedLanguage)}` : "";
  const result = await fetchMapperPath(`/mapper/${safeProvider}/chapters/${anilistId}${query}`);

  if (!result.ok) {
    return {
      provider: safeProvider,
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      data: [],
      error: result.error,
    };
  }

  return {
    provider: safeProvider,
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    data: extractChapterRows(result.payload, safeProvider),
  };
};

export const fetchMapperPages = async (
  provider: string,
  chapterId: string
): Promise<MapperFetchResult<MapperPage[]>> => {
  const safeProvider = provider.toLowerCase();
  const local = await fetchLocalMapperPages(safeProvider, chapterId);
  if (local) {
    return local;
  }

  const encodedChapterId = encodeURIComponent(chapterId);
  const result = await fetchMapperPath(`/mapper/${safeProvider}/pages/${encodedChapterId}`);

  if (!result.ok) {
    return {
      provider: safeProvider,
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      data: [],
      error: result.error,
    };
  }

  return {
    provider: safeProvider,
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    data: extractPageRows(result.payload),
  };
};

export const fetchAllMapperChapters = async (
  anilistId: number,
  providers: readonly string[] = MANGA_MAPPER_PROVIDERS,
  language?: string
) => {
  const settled = await Promise.allSettled(
    providers.map((provider) => fetchMapperChapters(provider, anilistId, language))
  );

  const success: MapperFetchResult<MapperChapter[]>[] = [];
  const failed: MapperFetchResult<MapperChapter[]>[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      if (result.value.ok) {
        success.push(result.value);
      } else {
        failed.push(result.value);
      }
      continue;
    }

    failed.push({
      provider: "unknown",
      ok: false,
      status: 503,
      latencyMs: 0,
      data: [],
      error: result.reason instanceof Error ? result.reason.message : "Mapper promise rejected",
    });
  }

  return { success, failed };
};

export const isSupportedMangaMapperProvider = (provider: string) =>
  MANGA_MAPPER_PROVIDERS.includes(provider.toLowerCase() as MangaMapperProvider);

export const getMapperBridgeConfig = () => ({
  baseUrl: readBaseUrl(),
  timeoutMs: readTimeoutMs(),
  cache: {
    directory: MANGA_MAPPER_CACHE_DIR,
    ttlMs: MAPPER_CACHE_TTL_MS,
    staleMs: MAPPER_CACHE_STALE_MS,
  },
});
