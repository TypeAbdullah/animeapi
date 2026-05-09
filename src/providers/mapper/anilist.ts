import { Cache } from "../../lib/cache.js";

const ANILIST_URL = "https://graphql.anilist.co";

export interface AnilistTitle {
  romaji?: string;
  english?: string;
  native?: string;
  userPreferred?: string;
}

export interface AnilistAnimeInfo {
  id: number;
  idMal?: number;
  title: AnilistTitle;
  description?: string;
  coverImage?: {
    large?: string;
    medium?: string;
  };
  bannerImage?: string;
  episodes?: number;
  status?: string;
  season?: string;
  seasonYear?: number;
  startDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  endDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  genres?: string[];
  source?: string;
  averageScore?: number;
  popularity?: number;
  duration?: number;
  synonyms?: string[];
  isAdult?: boolean;
  format?: string;
  type?: string;
}

export interface AnilistMangaInfo {
  id: number;
  idMal?: number;
  title: AnilistTitle;
  description?: string;
  coverImage?: {
    large?: string;
    medium?: string;
  };
  bannerImage?: string;
  chapters?: number;
  volumes?: number;
  status?: string;
  startDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  endDate?: {
    year?: number;
    month?: number;
    day?: number;
  };
  genres?: string[];
  averageScore?: number;
  popularity?: number;
  synonyms?: string[];
  isAdult?: boolean;
  format?: string;
  type?: string;
  countryOfOrigin?: string;
}

export class AniList {
  private baseUrl = ANILIST_URL;

  private async requestGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.error("AniList Rate Limit Exceeded (429)");
        }
        throw new Error(`AniList API returned ${response.status}`);
      }

      const json = (await response.json()) as any;
      if (json.errors) {
        console.error("AniList GraphQL Errors:", JSON.stringify(json.errors));
      }

      return (json.data || null) as T | null;
    } catch (error: any) {
      console.error("Error fetching from AniList:", error?.message || error);
      return null;
    }
  }

  async getAnimeInfo(id: number): Promise<AnilistAnimeInfo | null> {
    const cacheKey = `anilist:anime:${id}`;
    const cached = await Cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
            userPreferred
          }
          description
          coverImage {
            large
            medium
          }
          bannerImage
          episodes
          status
          season
          seasonYear
          startDate {
            year
            month
            day
          }
          endDate {
            year
            month
            day
          }
          genres
          source
          averageScore
          popularity
          duration
          synonyms
          isAdult
          format
          type
        }
      }
    `;

    const data = await this.requestGraphQL<{ Media: AnilistAnimeInfo | null }>(query, { id });
    const media = data?.Media || null;

    if (media) {
      await Cache.set(cacheKey, JSON.stringify(media), 86400);
    }

    return media;
  }

  async getMangaInfo(id: number): Promise<AnilistMangaInfo | null> {
    const cacheKey = `anilist:manga:${id}`;
    const cached = await Cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const query = `
      query ($id: Int) {
        Media(id: $id, type: MANGA) {
          id
          idMal
          title {
            romaji
            english
            native
            userPreferred
          }
          description
          coverImage {
            large
            medium
          }
          bannerImage
          chapters
          volumes
          status
          startDate {
            year
            month
            day
          }
          endDate {
            year
            month
            day
          }
          genres
          averageScore
          popularity
          synonyms
          isAdult
          format
          type
          countryOfOrigin
        }
      }
    `;

    const data = await this.requestGraphQL<{ Media: AnilistMangaInfo | null }>(query, { id });
    const media = data?.Media || null;

    if (media) {
      await Cache.set(cacheKey, JSON.stringify(media), 86400);
    }

    return media;
  }

  async getMangaInfoByMalId(malId: number): Promise<AnilistMangaInfo | null> {
    const cacheKey = `anilist:manga:mal:${malId}`;
    const cached = await Cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const query = `
      query ($idMal: Int) {
        Media(idMal: $idMal, type: MANGA) {
          id
          idMal
          title {
            romaji
            english
            native
            userPreferred
          }
          description
          coverImage {
            large
            medium
          }
          bannerImage
          chapters
          volumes
          status
          startDate {
            year
            month
            day
          }
          endDate {
            year
            month
            day
          }
          genres
          averageScore
          popularity
          synonyms
          isAdult
          format
          type
          countryOfOrigin
        }
      }
    `;

    const data = await this.requestGraphQL<{ Media: AnilistMangaInfo | null }>(query, { idMal: malId });
    const media = data?.Media || null;

    if (media) {
      await Cache.set(cacheKey, JSON.stringify(media), 86400);
    }

    return media;
  }

  async searchAnime(search: string, page: number = 1, perPage: number = 10): Promise<AnilistAnimeInfo[]> {
    const query = `
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          media(search: $search, type: ANIME) {
            id
            idMal
            title {
              romaji
              english
              native
              userPreferred
            }
            description
            coverImage {
              large
              medium
            }
            episodes
            duration
            status
            genres
            averageScore
            popularity
            startDate {
              year
              month
              day
            }
            synonyms
            isAdult
            format
            type
          }
        }
      }
    `;

    const data = await this.requestGraphQL<{ Page?: { media?: AnilistAnimeInfo[] } }>(query, {
      search,
      page,
      perPage,
    });

    return Array.isArray(data?.Page?.media) ? data!.Page!.media! : [];
  }

  async searchManga(search: string, page: number = 1, perPage: number = 10): Promise<AnilistMangaInfo[]> {
    const query = `
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          media(search: $search, type: MANGA) {
            id
            idMal
            title {
              romaji
              english
              native
              userPreferred
            }
            description
            coverImage {
              large
              medium
            }
            chapters
            volumes
            status
            genres
            averageScore
            popularity
            startDate {
              year
              month
              day
            }
            endDate {
              year
              month
              day
            }
            synonyms
            isAdult
            format
            type
            countryOfOrigin
          }
        }
      }
    `;

    const data = await this.requestGraphQL<{ Page?: { media?: AnilistMangaInfo[] } }>(query, {
      search,
      page,
      perPage,
    });

    return Array.isArray(data?.Page?.media) ? data!.Page!.media! : [];
  }
}
