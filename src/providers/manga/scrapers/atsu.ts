import axios, { type AxiosInstance } from "axios";

const BASE_URL = "https://atsu.moe";
const API_HOME = `${BASE_URL}/api/home/page`;

function toAtsuImageUrl(imagePath: string): string {
  if (!imagePath) return "";
  const trimmed = String(imagePath).trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const normalizedPath = trimmed.replace(/^\//, "");
  const relativePath = normalizedPath.startsWith("static/")
    ? normalizedPath
    : `static/${normalizedPath}`;

  return `${BASE_URL}/${relativePath}`;
}

function proxyAtsuImage(imagePath: string, baseApiUrl: string): string {
  if (!imagePath) return "";
  const root = baseApiUrl.replace(/\/$/, "");
  const normalizedPath = imagePath.replace(/^\//, "");

  if (normalizedPath.startsWith("static/")) {
    return `${root}/image/atsu.moe/${normalizedPath}`;
  }
  return `${root}/image/atsu.moe/static/${normalizedPath}`;
}

export class AtsuParser {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        Referer: `${BASE_URL}/`,
      },
    });
  }

  private transformItem(item: any, _baseApiUrl: string) {
    return {
      id: item.id,
      title: item.title,
      thumbnail: toAtsuImageUrl(item.image),
      images: {
        small: toAtsuImageUrl(item.smallImage),
        medium: toAtsuImageUrl(item.mediumImage),
        large: toAtsuImageUrl(item.largeImage),
      },
      type: item.type,
      isAdult: item.isAdult ?? false,
    };
  }

  /**
   * Internal helper to poll an endpoint. Atsu frequently returns empty items
   * initially while it fetches data in the background.
   */
  private async pollApi(url: string, maxAttempts: number, delayMs: number): Promise<any> {
    let lastData = null;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const { data } = await this.http.get(url);
        lastData = data;

        // If we got valid items, break out of the loop early and return them!
        if (data && Array.isArray(data.items) && data.items.length > 0) {
          return data;
        }
      } catch (_err) {
        // Ignore network errors during polling, we will just try again
      }

      // Wait for delayMs before the next attempt (don't wait after the last attempt)
      if (i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return lastData;
  }

  async parseHome(baseApiUrl: string, isAdult: boolean = false): Promise<any> {
    try {
      const url = isAdult ? `${API_HOME}?adult=1` : API_HOME;
      const { data } = await this.http.get(url);
      const result: Record<string, any> = {};

      data.homePage.sections.forEach((section: any) => {
        if (section.layout === "carousel") {
          result[section.key] = {
            title: section.title,
            items: (section.items || []).map((item: any) => this.transformItem(item, baseApiUrl)),
          };
        }
      });
      return result;
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchInfiniteSection(
    section: string,
    page: number,
    queryParams: Record<string, string>,
    baseApiUrl: string,
    isAdult: boolean = false,
  ): Promise<any> {
    try {
      const params = new URLSearchParams({ page: page.toString(), ...queryParams });
      if (isAdult) params.set("adult", "1");

      const url = `/api/infinite/${section}?${params.toString()}`;
      const { data } = await this.http.get(url);

      return {
        page,
        items: (data.items || []).map((item: any) => this.transformItem(item, baseApiUrl)),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchMangaDetails(id: string, _baseApiUrl: string): Promise<any> {
    try {
      const { data } = await this.http.get(`/api/manga/page?id=${encodeURIComponent(id)}`);
      if (!data || !data.mangaPage) return { error: "Manga not found" };

      const manga = data.mangaPage;
      let chapters = manga.chapters || [];

      if (manga.hasMoreChapters) {
        try {
          const allChapsRes = await this.http.get(
            `/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`,
          );
          if (allChapsRes.data?.chapters) chapters = allChapsRes.data.chapters;
        } catch (_e) {
          console.error("Failed to fetch all chapters, falling back to partial list.");
        }
      }

      const scanlatorMap: Record<string, string> = {};
      if (manga.scanlators) {
        manga.scanlators.forEach((scan: any) => {
          scanlatorMap[scan.id] = scan.name;
        });
      }

      return {
        id: manga.id,
        title: manga.title,
        englishTitle: manga.englishTitle || null,
        altTitles: manga.otherNames || [],
        synopsis: manga.synopsis || "",
        type: manga.type,
        isAdult: manga.isAdult ?? false,
        status: manga.status || "Unknown",
        genres: (manga.genres || []).map((g: any) => ({
          genre: g.name,
          slug: g.id,
        })),
        authors: (manga.authors || []).map((a: any) => ({
          author: a.name,
          slug: a.slug || a.id,
          role: a.type || "Author",
        })),
        scanlators: manga.scanlators || [],
        poster: toAtsuImageUrl(manga.poster?.image || manga.poster?.id),
        banner: manga.banner?.url ? toAtsuImageUrl(manga.banner.url) : "",
        rating: manga.avgRating || null,
        views: manga.views || null,
        totalChapters: manga.totalChapterCount || chapters.length,
        chapters: chapters.map((ch: any) => {
          const scanId = ch.scanlationMangaId || ch.scanId || null;
          return {
            id: ch.id,
            title: ch.title || `Chapter ${ch.number}`,
            number: ch.number,
            pages: ch.pageCount,
            createdAt: ch.createdAt,
            scanId: scanId,
            scanlator: scanId ? scanlatorMap[scanId] || "Unknown" : "Unknown",
          };
        }),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchChapterInfo(id: string): Promise<any> {
    try {
      const { data } = await this.http.get(`/api/manga/info?mangaId=${encodeURIComponent(id)}`);
      if (!data || !data.id) return { error: "Info not found" };

      return {
        id: data.id,
        title: data.title,
        type: data.type,
        chapters: (data.chapters || []).map((ch: any) => ({
          id: ch.id,
          title: ch.title || `Chapter ${ch.number}`,
          number: ch.number,
          pages: ch.pageCount,
          scanId: ch.scanId,
        })),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchChapterPages(mangaId: string, chapterId: string, baseApiUrl: string): Promise<any> {
    try {
      const { data } = await this.http.get(
        `/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
      );
      if (!data || !data.readChapter) return { error: "Chapter not found" };

      const ch = data.readChapter;
      return {
        id: ch.id,
        title: ch.title,
        pages: (ch.pages || []).map((img: any) => ({
          img: proxyAtsuImage(img.image, baseApiUrl),
          page: img.number,
        })),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchFilters(): Promise<any> {
    try {
      const { data } = await this.http.get("/api/explore/availableFilters");
      return {
        genres: (data.genres || []).map((g: any) => ({ name: g.name, slug: g.id })),
        types: (data.types || []).map((t: any) => ({ name: t.name, slug: t.id })),
        statuses: (data.statuses || []).map((s: any) => ({ name: s.name, slug: s.id })),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async fetchFilteredView(
    params: {
      genres?: string;
      authors?: string;
      types?: string;
      statuses?: string;
      page?: number;
      adult?: boolean;
    },
    baseApiUrl: string,
  ): Promise<any> {
    try {
      const payload: Record<string, any> = {
        filter: {
          genres: params.genres ? params.genres.split(",").map((x) => x.trim()) : [],
          types: params.types
            ? params.types.split(",").map((x) => x.trim())
            : ["Manga", "Manwha", "Manhua", "OEL"],
          statuses: params.statuses ? params.statuses.split(",").map((x) => x.trim()) : [],
        },
        page: params.page || 0,
      };

      if (params.authors) {
        payload.filter.authors = params.authors.split(",").map((x: string) => x.trim());
      }

      const url = params.adult ? "/api/explore/filteredView?adult=1" : "/api/explore/filteredView";
      const { data } = await this.http.post(url, payload);

      return {
        page: params.page || 0,
        items: (data.items || []).map((item: any) => this.transformItem(item, baseApiUrl)),
      };
    } catch (err: any) {
      const errorMessage = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      return { error: `[Atsu API ${err.response?.status || "Error"}] ${errorMessage}` };
    }
  }

  async fetchAuthor(
    slug: string,
    page: number,
    type: string | undefined,
    baseApiUrl: string,
  ): Promise<any> {
    try {
      let currentType = type || "Author";
      let url = `/api/browse/author?authorSlug=${encodeURIComponent(slug)}&type=${currentType}&page=${page}`;

      // Poll up to 4 times (1.5 seconds apart) ~ max 6 seconds total
      let data = await this.pollApi(url, 4, 1500);

      // Smart Fallback: If still empty and no explicit role was requested, try searching them as an Artist
      if ((!data || !data.items || data.items.length === 0) && !type) {
        currentType = "Artist";
        url = `/api/browse/author?authorSlug=${encodeURIComponent(slug)}&type=${currentType}&page=${page}`;
        // Poll up to 3 times (1.5 seconds apart) ~ max 4.5 seconds total
        data = await this.pollApi(url, 3, 1500);
      }

      if (!data || !data.items) return { error: "Author not found" };

      return {
        author: data.author?.name || slug,
        role: currentType,
        page,
        items: data.items.map((item: any) => this.transformItem(item, baseApiUrl)),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async proxyImage(path: string): Promise<{ content: Buffer; contentType: string } | null> {
    try {
      const resp = await this.http.get(`https://${path}`, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
          Referer: `${BASE_URL}/`,
        },
      });
      if (resp.status === 200) {
        const contentType = (resp.headers["content-type"] as string) || "image/jpeg";
        return { content: Buffer.from(resp.data as ArrayBuffer), contentType };
      }
    } catch {
      return null;
    }
    return null;
  }
}

export const atsu = new AtsuParser();
