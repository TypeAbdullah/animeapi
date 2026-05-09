import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  cacheGetMock,
  cacheSetMock,
  getMangaInfoMock,
  getMangaInfoByMalIdMock,
  searchMangaMock,
  fetchAllMapperChaptersMock,
  fetchMapperPagesMock,
  supportedProviders,
} = vi.hoisted(() => ({
  cacheGetMock: vi.fn(),
  cacheSetMock: vi.fn(),
  getMangaInfoMock: vi.fn(),
  getMangaInfoByMalIdMock: vi.fn(),
  searchMangaMock: vi.fn(),
  fetchAllMapperChaptersMock: vi.fn(),
  fetchMapperPagesMock: vi.fn(),
  supportedProviders: ["mangadex", "asurascans", "mangafire"],
}));

vi.mock("../src/lib/cache.js", () => ({
  Cache: {
    get: (...args: unknown[]) => cacheGetMock(...args),
    set: (...args: unknown[]) => cacheSetMock(...args),
    del: vi.fn(),
  },
}));

vi.mock("../src/providers/mapper/anilist.js", () => ({
  AniList: class {
    getMangaInfo = getMangaInfoMock;
    getMangaInfoByMalId = getMangaInfoByMalIdMock;
    searchManga = searchMangaMock;
  },
}));

vi.mock("../src/providers/manga/mapperBridge.js", () => ({
  MANGA_MAPPER_PROVIDERS: supportedProviders,
  fetchAllMapperChapters: (...args: unknown[]) => fetchAllMapperChaptersMock(...args),
  fetchMapperPages: (...args: unknown[]) => fetchMapperPagesMock(...args),
  isSupportedMangaMapperProvider: (provider: string) => supportedProviders.includes(provider.toLowerCase()),
}));

import { buildChapterKey, getMangaChapters, getMangaRead } from "../src/providers/manga/service.js";

beforeEach(() => {
  vi.clearAllMocks();

  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(true);

  getMangaInfoMock.mockResolvedValue({
    id: 151807,
    idMal: 167235,
    title: {
      romaji: "Solo Leveling",
      english: "Solo Leveling",
      native: "\uc194\ub85c \ub808\ubca8\ub9c1",
    },
    status: "RELEASING",
    chapters: 200,
    volumes: 20,
    genres: ["Action"],
    averageScore: 82,
    popularity: 100000,
    countryOfOrigin: "KR",
    isAdult: false,
    coverImage: {
      large: "https://img.example/solo.jpg",
    },
    synonyms: [],
  });

  getMangaInfoByMalIdMock.mockResolvedValue(null);
  searchMangaMock.mockResolvedValue([]);

  fetchAllMapperChaptersMock.mockResolvedValue({
    success: [],
    failed: [],
  });

  fetchMapperPagesMock.mockResolvedValue({
    provider: "mangadex",
    ok: true,
    status: 200,
    latencyMs: 12,
    data: [{ url: "https://img.example/page-1.jpg", index: 0 }],
  });
});

describe("Manga Service Behaviors", () => {
  test("returns mapped chapters and provider status including unsupported providers", async () => {
    fetchAllMapperChaptersMock.mockResolvedValue({
      success: [
        {
          provider: "mangadex",
          ok: true,
          status: 200,
          latencyMs: 11,
          data: [
            {
              id: "md-1",
              number: 1,
              title: "Arrival",
              language: "en",
            },
          ],
        },
        {
          provider: "asurascans",
          ok: true,
          status: 200,
          latencyMs: 15,
          data: [
            {
              id: "as-1",
              number: 1,
              title: "Arrival",
              language: "en",
            },
          ],
        },
      ],
      failed: [],
    });

    const response = await getMangaChapters("151807", {
      providers: ["mangadex", "asurascans", "unknown"],
      language: "en",
    });

    expect(fetchAllMapperChaptersMock).toHaveBeenCalledWith(151807, ["mangadex", "asurascans"], "en");
    expect(response).not.toBeNull();
    expect(response?.chapters).toHaveLength(2);
    expect(response?.mappedChapters).toHaveLength(1);

    const sources = response?.mappedChapters[0]?.sources || [];
    expect(sources.map((source) => source.provider).sort()).toEqual(["asurascans", "mangadex"]);

    expect(response?.failedProviders).toEqual(["unknown"]);
    expect(response?.providerStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "mangadex", success: true, chapterCount: 1 }),
        expect.objectContaining({ provider: "asurascans", success: true, chapterCount: 1 }),
        expect.objectContaining({ provider: "unknown", success: false, error: "Provider not supported" }),
      ])
    );
  });

  test("reads from explicit provider selection without fallback", async () => {
    fetchMapperPagesMock.mockResolvedValue({
      provider: "mangadex",
      ok: false,
      status: 502,
      latencyMs: 9,
      data: [],
      error: "mapper upstream failed",
    });

    const result = await getMangaRead("151807", {
      provider: "mangadex",
      chapterId: "chapter-1",
    });

    expect(fetchMapperPagesMock).toHaveBeenCalledTimes(1);
    expect(fetchMapperPagesMock).toHaveBeenCalledWith("mangadex", "chapter-1");
    expect(result.response).toBeNull();
    expect(result.failedProviders).toEqual(["mangadex"]);
    expect(result.error).toBe("mapper upstream failed");
  });

  test("falls back to another provider when chapterKey source has no pages", async () => {
    fetchAllMapperChaptersMock.mockResolvedValue({
      success: [
        {
          provider: "mangadex",
          ok: true,
          status: 200,
          latencyMs: 10,
          data: [
            {
              id: "md-10",
              number: 10,
              title: "Chapter 10",
              language: "en",
            },
          ],
        },
        {
          provider: "mangafire",
          ok: true,
          status: 200,
          latencyMs: 11,
          data: [
            {
              id: "mf-10",
              number: 10,
              title: "Chapter 10",
              language: "en",
            },
          ],
        },
      ],
      failed: [],
    });

    fetchMapperPagesMock
      .mockResolvedValueOnce({
        provider: "mangadex",
        ok: false,
        status: 404,
        latencyMs: 9,
        data: [],
        error: "No chapter pages found",
      })
      .mockResolvedValueOnce({
        provider: "mangafire",
        ok: true,
        status: 200,
        latencyMs: 7,
        data: [{ url: "https://img.example/fallback-page-1.jpg", index: 0 }],
      });

    const chapterKey = buildChapterKey("mangadex", "md-10", 10);
    const result = await getMangaRead("151807", { chapterKey });

    expect(fetchMapperPagesMock).toHaveBeenNthCalledWith(1, "mangadex", "md-10");
    expect(fetchMapperPagesMock).toHaveBeenNthCalledWith(2, "mangafire", "mf-10");
    expect(result.response?.chapter.provider).toBe("mangafire");
    expect(result.response?.chapter.providerChapterId).toBe("mf-10");
    expect(result.response?.readMeta.fallbackUsed).toBe(true);
    expect(result.failedProviders).toContain("mangadex");
    expect(result.partial).toBe(true);
  });

  test("returns guidance when no pages are available and no fallback succeeds", async () => {
    fetchAllMapperChaptersMock.mockResolvedValue({
      success: [
        {
          provider: "mangadex",
          ok: true,
          status: 200,
          latencyMs: 9,
          data: [
            {
              id: "md-10",
              number: 10,
              title: "Chapter 10",
              language: "en",
            },
          ],
        },
      ],
      failed: [],
    });

    fetchMapperPagesMock.mockResolvedValue({
      provider: "mangadex",
      ok: false,
      status: 404,
      latencyMs: 8,
      data: [],
      error: "No chapter pages found",
    });

    const chapterKey = buildChapterKey("mangadex", "md-10", 10);
    const result = await getMangaRead("151807", { chapterKey });

    expect(result.response).toBeNull();
    expect(result.guidance?.code).toBe("MANGADEX_NO_PAGES");
    expect(result.guidance?.retryable).toBe(true);
    expect(result.failedProviders).toEqual(["mangadex"]);
  });

  test("accepts chapterKey selection for direct provider read", async () => {
    const chapterKey = buildChapterKey("mangadex", "md-10", 10);

    const result = await getMangaRead("151807", { chapterKey });

    expect(fetchMapperPagesMock).toHaveBeenCalledWith("mangadex", "md-10");
    expect(result.response?.chapter.provider).toBe("mangadex");
    expect(result.response?.chapter.providerChapterId).toBe("md-10");
  });
});
