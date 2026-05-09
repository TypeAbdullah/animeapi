
import { AniList } from "./anilist.js";
import type { AnilistAnimeInfo } from "./anilist.js";
import { Animepahe } from "../animepahe/animepahe.js";

export class AnimepaheMapper {
  private anilist: AniList;

  constructor() {
    this.anilist = new AniList();
  }

  async mapAnilistToAnimePahe(anilistId: number) {
    try {
      const animeInfo = await this.anilist.getAnimeInfo(anilistId);

      if (!animeInfo) {
        throw new Error(`Anime with id ${anilistId} not found on AniList`);
      }

      const bestMatch = await this.findAnimePaheMatch(animeInfo);

      if (!bestMatch) {
        return {
          id: animeInfo.id,
          animepahe: null,
        };
      }

      // In TatakaiCore, we can just return the mapping. 
      // The frontend or other services can then use Animepahe.info(bestMatch.session) if needed.
      return {
        id: animeInfo.id,
        animepahe: {
          id: bestMatch.id,
          title: bestMatch.title,
          type: bestMatch.type,
          status: bestMatch.status,
          year: bestMatch.year,
          score: bestMatch.score,
          posterImage: bestMatch.poster,
          session: bestMatch.session,
        },
      };
    } catch (error: any) {
      console.error("Error mapping AniList to AnimePahe:", error.message);
      throw new Error("Failed to map AniList to AnimePahe: " + error.message);
    }
  }

  private async findAnimePaheMatch(animeInfo: AnilistAnimeInfo) {
    const titles = [
      animeInfo.title.romaji,
      animeInfo.title.english,
      animeInfo.title.userPreferred,
    ].filter(Boolean) as string[];

    for (const title of titles) {
      const searchResults = await Animepahe.search(title);

      if (searchResults && searchResults.length > 0) {
        // Try strict ID match first if possible (some providers put MAL/Anilist IDs in metadata)
        // But AnimePahe usually doesn't show them in search API.
        
        const match = this.findBestMatchFromResults(animeInfo, searchResults);
        if (match) return match;
      }
    }

    return null;
  }

  private findBestMatchFromResults(animeInfo: AnilistAnimeInfo, results: any[]) {
    if (!results || results.length === 0) return null;

    const normalizeTitle = (t: string) =>
      t.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

    const anilistTitles = [
      animeInfo.title.romaji,
      animeInfo.title.english,
      animeInfo.title.userPreferred,
    ]
      .filter(Boolean)
      .map((t) => normalizeTitle(t!));

    const anilistYear =
      animeInfo.startDate?.year || animeInfo.seasonYear;

    let bestMatch = null;
    let highestScore = 0;

    for (const result of results) {
      const resultTitle = normalizeTitle(result.title);
      const resultYear = result.year ? parseInt(result.year) : null;

      let score = 0;

      // Year match is a strong signal
      if (anilistYear && resultYear && Math.abs(anilistYear - resultYear) <= 1) {
        score += 0.3;
      }

      // Title similarity
      let maxSimilarity = 0;
      for (const aTitle of anilistTitles) {
        const similarity = this.calculateTitleSimilarity(aTitle, resultTitle);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
      score += maxSimilarity * 0.7;

      if (score > highestScore) {
        highestScore = score;
        bestMatch = result;
      }
    }

    return highestScore > 0.6 ? bestMatch : null;
  }

  private calculateTitleSimilarity(title1: string, title2: string): number {
    if (title1 === title2) return 1;
    const words1 = title1.split(" ").filter(Boolean);
    const words2 = title2.split(" ").filter(Boolean);

    const commonCount = words1.filter((w) => words2.includes(w)).length;
    return (commonCount * 2) / (words1.length + words2.length);
  }
}
