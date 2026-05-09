
import { AniList } from "./anilist.js";
import type { AnilistAnimeInfo } from "./anilist.js";
import { AnimeKai } from "../animekai/animekai.js";

export class AnimeKaiMapper {
  private anilist: AniList;

  constructor() {
    this.anilist = new AniList();
  }

  async mapAnilistToAnimeKai(anilistId: number) {
    try {
      const animeInfo = await this.anilist.getAnimeInfo(anilistId);

      if (!animeInfo) {
        throw new Error(`Anime with id ${anilistId} not found on AniList`);
      }

      const searchTitle = animeInfo.title.english || animeInfo.title.romaji || animeInfo.title.userPreferred;
      if (!searchTitle) {
        throw new Error("No title available for the anime");
      }

      // Try titles in order
      const titles = [
        animeInfo.title.english,
        animeInfo.title.romaji,
        ...(animeInfo.synonyms || []),
      ].filter(Boolean) as string[];

      let bestMatch = null;

      for (const title of titles) {
        const searchResults = await AnimeKai.search(title);
        if (searchResults && searchResults.results && searchResults.results.length > 0) {
          bestMatch = this.findBestMatch(title, animeInfo, searchResults.results);
          if (bestMatch) break;
        }
      }

      if (!bestMatch) {
         // Final fallback: try suggestions API which is sometimes more lenient
         const suggestions = await AnimeKai.suggestions(searchTitle);
         if (suggestions && suggestions.length > 0) {
            bestMatch = this.findBestMatch(searchTitle, animeInfo, suggestions);
         }
      }

      if (!bestMatch) {
        return {
          id: animeInfo.id,
          title: searchTitle,
          animekai: null,
        };
      }

      const animeDetails = await AnimeKai.info(bestMatch.id);

      return {
        id: animeInfo.id,
        title: searchTitle,
        animekai: {
          id: bestMatch.id,
          title: bestMatch.title,
          japaneseTitle: bestMatch.japaneseTitle,
          url: bestMatch.url || `https://animekai.to/watch/${bestMatch.id}`,
          image: bestMatch.image,
          type: bestMatch.type,
          episodes: animeDetails?.totalEpisodes || bestMatch.episodes,
          episodesList: animeDetails?.episodes || [],
          hasSub: animeDetails?.hasSub,
          hasDub: animeDetails?.hasDub,
          subOrDub: animeDetails?.subOrDub,
          status: animeDetails?.status,
          season: animeDetails?.season,
          genres: animeDetails?.genres,
        },
      };
    } catch (error: any) {
      console.error("Error mapping AniList to AnimeKai:", error);
      throw error;
    }
  }

  private findBestMatch(searchTitle: string, animeInfo: AnilistAnimeInfo, results: any[]) {
    if (!results || results.length === 0) return null;

    const normalizeTitle = (title: string) =>
      title.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

    const normalizedSearch = normalizeTitle(searchTitle);
    const expectedEpisodes = animeInfo.episodes || 0;

    // 1. Strict title match
    for (const result of results) {
      const resultTitle = normalizeTitle(result.title);
      const japaneseTitle = result.japaneseTitle ? normalizeTitle(result.japaneseTitle) : "";

      if (resultTitle === normalizedSearch || japaneseTitle === normalizedSearch) {
        return result;
      }
    }

    // 2. Title inclusion + episode count match
    for (const result of results) {
      const resultTitle = normalizeTitle(result.title);
      const japaneseTitle = result.japaneseTitle ? normalizeTitle(result.japaneseTitle) : "";

      if (result.episodes === expectedEpisodes && expectedEpisodes > 0) {
        if (
          resultTitle.includes(normalizedSearch) ||
          normalizedSearch.includes(resultTitle) ||
          japaneseTitle.includes(normalizedSearch) ||
          normalizedSearch.includes(japaneseTitle)
        ) {
          return result;
        }
      }
    }

    // 3. Fallback to first result if it's reasonably similar
    const firstResult = results[0];
    const firstTitle = normalizeTitle(firstResult.title);
    if (firstTitle.includes(normalizedSearch) || normalizedSearch.includes(firstTitle)) {
        return firstResult;
    }

    return null;
  }
}
