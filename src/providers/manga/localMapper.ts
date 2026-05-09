import { AniList } from "../mapper/anilist.js";
import { mangafire } from "./scrapers/mangafire.js";
import type { MapperChapter, MapperFetchResult, MapperPage } from "./mapperBridge.js";

const MANGADEX_API = "https://api.mangadex.org";
const DEFAULT_TIMEOUT_MS = 12000;
const anilist = new AniList();

const now = () => Date.now();

const toLower = (value: unknown) => String(value || "").trim().toLowerCase();

const normalizeTitle = (value: string) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const titleScore = (left: string, right: string) => {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aWords = a.split(" ").filter(Boolean);
  const bWords = new Set(b.split(" ").filter(Boolean));
  const common = aWords.filter((word) => bWords.has(word)).length;
  const overlap = common / Math.max(aWords.length, bWords.size || 1);

  if (a.includes(b) || b.includes(a)) {
    return Math.max(overlap, 0.9);
  }

  return overlap;
};

const toErrorResult = <T>(
  provider: string,
  start: number,
  status: number,
  message: string,
  data: T
): MapperFetchResult<T> => ({
  provider,
  ok: false,
  status,
  latencyMs: now() - start,
  data,
  error: message,
});

const getAniListTitleCandidates = async (anilistId: number) => {
  const media = await anilist.getMangaInfo(anilistId);
  if (!media) return [];

  const candidates = [
    media.title?.english,
    media.title?.romaji,
    media.title?.userPreferred,
    media.title?.native,
    ...(Array.isArray(media.synonyms) ? media.synonyms : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set(candidates)];
};

const resolveMangafireIdFromAnilistId = async (anilistId: number) => {
  const titles = await getAniListTitleCandidates(anilistId);
  if (titles.length === 0) return null;

  let bestMatch: { id: string; score: number } | null = null;

  for (const title of titles) {
    const result = await mangafire.search(title, 1);
    const rows = Array.isArray(result?.results) ? result.results : [];

    for (const row of rows) {
      const rowId = String(row?.id || "").trim();
      const rowTitle = String(row?.title || "").trim();
      if (!rowId || !rowTitle) continue;

      const score = titleScore(title, rowTitle);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { id: rowId, score };
      }
    }

    if (bestMatch && bestMatch.score >= 0.97) {
      break;
    }
  }

  if (!bestMatch || bestMatch.score < 0.35) {
    return null;
  }

  return bestMatch.id;
};

const mapMangafireChapters = (rows: any[], providerMangaId: string, language: string): MapperChapter[] => {
  return rows
    .map((row) => ({
      id: String(row?.chapterId || row?.id || ""),
      title: row?.title ? String(row.title) : undefined,
      number: row?.number,
      volume: undefined,
      date: row?.releaseDate ? String(row.releaseDate) : undefined,
      language,
      scanlator: undefined,
      providerMangaId,
    }))
    .filter((chapter) => chapter.id.length > 0);
};

const fetchMangafireChapters = async (
  anilistId: number,
  language?: string
): Promise<MapperFetchResult<MapperChapter[]>> => {
  const provider = "mangafire";
  const start = now();

  try {
    const providerMangaId = await resolveMangafireIdFromAnilistId(anilistId);
    if (!providerMangaId) {
      return toErrorResult(provider, start, 404, `Unable to map AniList ID ${anilistId} to MangaFire`, []);
    }

    const lang = toLower(language) || "en";
    const rows = await mangafire.getChapters(providerMangaId, lang);
    if (!Array.isArray(rows)) {
      const error = String((rows as any)?.error || "MangaFire chapter fetch failed");
      return toErrorResult(provider, start, 502, error, []);
    }

    return {
      provider,
      ok: true,
      status: 200,
      latencyMs: now() - start,
      data: mapMangafireChapters(rows, providerMangaId, lang),
    };
  } catch (error: any) {
    return toErrorResult(provider, start, 503, error?.message || "MangaFire mapper failed", []);
  }
};

const fetchMangafirePages = async (chapterId: string): Promise<MapperFetchResult<MapperPage[]>> => {
  const provider = "mangafire";
  const start = now();

  try {
    const rows = await mangafire.getChapterImages(chapterId);
    if (!Array.isArray(rows)) {
      const error = String((rows as any)?.error || "MangaFire pages fetch failed");
      return toErrorResult(provider, start, 502, error, []);
    }

    const pages: MapperPage[] = rows
      .map((url: any, index: number) => ({
        url: String(url || ""),
        index,
      }))
      .filter((page: MapperPage) => page.url.length > 0);

    return {
      provider,
      ok: true,
      status: 200,
      latencyMs: now() - start,
      data: pages,
    };
  } catch (error: any) {
    return toErrorResult(provider, start, 503, error?.message || "MangaFire mapper failed", []);
  }
};

const fetchJson = async (url: string, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: "application/json",
    },
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { response, payload };
};

const extractMangaDexCandidateTitles = (item: any): string[] => {
  const attributes = item?.attributes || {};
  const primary = Object.values(attributes?.title || {})
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const alt = Array.isArray(attributes?.altTitles)
    ? attributes.altTitles.flatMap((entry: any) =>
        Object.values(entry || {}).map((value) => String(value || "").trim()).filter(Boolean)
      )
    : [];

  return [...new Set([...primary, ...alt])];
};

const resolveMangaDexIdFromAnilistId = async (anilistId: number) => {
  const titles = await getAniListTitleCandidates(anilistId);
  if (titles.length === 0) return null;

  const seen = new Map<string, any>();

  for (const title of titles) {
    const url = new URL(`${MANGADEX_API}/manga`);
    url.searchParams.set("title", title);
    url.searchParams.set("limit", "20");
    url.searchParams.append("contentRating[]", "safe");
    url.searchParams.append("contentRating[]", "suggestive");
    url.searchParams.append("contentRating[]", "erotica");
    url.searchParams.append("contentRating[]", "pornographic");

    const { response, payload } = await fetchJson(url.toString());
    if (!response.ok) continue;

    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      if (!row?.id) continue;
      seen.set(String(row.id), row);
    }
  }

  const candidates = [...seen.values()];
  if (candidates.length === 0) return null;

  const withExactLink = candidates.find((candidate) => {
    const linkedAnilistId = String(candidate?.attributes?.links?.al || "").trim();
    return linkedAnilistId === String(anilistId);
  });
  if (withExactLink?.id) return String(withExactLink.id);

  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const candidateTitles = extractMangaDexCandidateTitles(candidate);
    if (candidateTitles.length === 0) continue;

    const score = Math.max(
      ...titles.map((searchTitle) =>
        Math.max(...candidateTitles.map((candidateTitle) => titleScore(searchTitle, candidateTitle)))
      )
    );

    if (!best || score > best.score) {
      best = { id: String(candidate.id), score };
    }
  }

  if (!best || best.score < 0.35) return null;
  return best.id;
};

const fetchMangaDexChapters = async (
  anilistId: number,
  language?: string
): Promise<MapperFetchResult<MapperChapter[]>> => {
  const provider = "mangadex";
  const start = now();

  try {
    const mangaDexId = await resolveMangaDexIdFromAnilistId(anilistId);
    if (!mangaDexId) {
      return toErrorResult(provider, start, 404, `Unable to map AniList ID ${anilistId} to MangaDex`, []);
    }

    const lang = toLower(language);
    const results: any[] = [];
    let offset = 0;
    const limit = 500;

    for (let page = 0; page < 6; page++) {
      const url = new URL(`${MANGADEX_API}/manga/${mangaDexId}/feed`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order[chapter]", "asc");
      url.searchParams.append("includes[]", "scanlation_group");
      if (lang) {
        url.searchParams.append("translatedLanguage[]", lang);
      }

      const { response, payload } = await fetchJson(url.toString());
      if (!response.ok) {
        const error = String(payload?.errors?.[0]?.detail || payload?.message || `MangaDex request failed with ${response.status}`);
        return toErrorResult(provider, start, response.status, error, []);
      }

      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (rows.length === 0) break;
      results.push(...rows);

      offset += rows.length;
      const total = Number(payload?.total || 0);
      if (!Number.isFinite(total) || offset >= total) break;
    }

    const chapters: MapperChapter[] = results
      .map((row) => {
        const attributes = row?.attributes || {};
        const groups = Array.isArray(row?.relationships)
          ? row.relationships
              .filter((relation: any) => relation?.type === "scanlation_group")
              .map((relation: any) => String(relation?.attributes?.name || "").trim())
              .filter(Boolean)
          : [];

        const translatedLanguage = String(attributes?.translatedLanguage || lang || "").trim() || undefined;

        return {
          id: String(row?.id || ""),
          title: attributes?.title ? String(attributes.title) : undefined,
          number: attributes?.chapter,
          volume: attributes?.volume,
          url: `https://mangadex.org/chapter/${String(row?.id || "")}`,
          date: attributes?.publishAt ? String(attributes.publishAt) : undefined,
          language: translatedLanguage,
          scanlator: groups.length > 0 ? groups.join(", ") : undefined,
          providerMangaId: mangaDexId,
        } as MapperChapter;
      })
      .filter((chapter) => chapter.id.length > 0);

    return {
      provider,
      ok: true,
      status: 200,
      latencyMs: now() - start,
      data: chapters,
    };
  } catch (error: any) {
    return toErrorResult(provider, start, 503, error?.message || "MangaDex mapper failed", []);
  }
};

const fetchMangaDexPages = async (chapterId: string): Promise<MapperFetchResult<MapperPage[]>> => {
  const provider = "mangadex";
  const start = now();

  try {
    const url = `${MANGADEX_API}/at-home/server/${encodeURIComponent(chapterId)}`;
    const { response, payload } = await fetchJson(url);

    if (!response.ok) {
      const error = String(payload?.errors?.[0]?.detail || payload?.message || `MangaDex request failed with ${response.status}`);
      return toErrorResult(provider, start, response.status, error, []);
    }

    const baseUrl = String(payload?.baseUrl || "").trim();
    const hash = String(payload?.chapter?.hash || "").trim();
    const data = Array.isArray(payload?.chapter?.data)
      ? payload.chapter.data
      : Array.isArray(payload?.chapter?.dataSaver)
        ? payload.chapter.dataSaver
        : [];

    if (!baseUrl || !hash || data.length === 0) {
      return toErrorResult(provider, start, 404, "No chapter pages found", []);
    }

    const pages: MapperPage[] = data
      .map((fileName: any, index: number) => ({
        url: `${baseUrl}/data/${hash}/${String(fileName)}`,
        index,
      }))
      .filter((page: MapperPage) => page.url.length > 0);

    return {
      provider,
      ok: true,
      status: 200,
      latencyMs: now() - start,
      data: pages,
    };
  } catch (error: any) {
    return toErrorResult(provider, start, 503, error?.message || "MangaDex mapper failed", []);
  }
};

export const fetchLocalMapperChapters = async (
  provider: string,
  anilistId: number,
  language?: string
): Promise<MapperFetchResult<MapperChapter[]> | null> => {
  const normalizedProvider = toLower(provider);

  if (normalizedProvider === "mangafire") {
    return fetchMangafireChapters(anilistId, language);
  }

  if (normalizedProvider === "mangadex") {
    return fetchMangaDexChapters(anilistId, language);
  }

  return null;
};

export const fetchLocalMapperPages = async (
  provider: string,
  chapterId: string
): Promise<MapperFetchResult<MapperPage[]> | null> => {
  const normalizedProvider = toLower(provider);

  if (normalizedProvider === "mangafire") {
    return fetchMangafirePages(chapterId);
  }

  if (normalizedProvider === "mangadex") {
    return fetchMangaDexPages(chapterId);
  }

  return null;
};
