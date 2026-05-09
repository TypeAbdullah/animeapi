
import { load } from "cheerio";
import stringSimilarity from "string-similarity";
import { AniList } from "./anilist.js";
import type { AnilistAnimeInfo } from "./anilist.js";
import { hianime as HIANIME_BASE_URL } from "../../origins.js";

export class HianimeMapper {
  private anilist: AniList;

  constructor() {
    this.anilist = new AniList();
  }

  async mapAnilistToHiAnime(anilistId: number) {
    try {
      const animeInfo = await this.anilist.getAnimeInfo(anilistId);
      if (!animeInfo) {
        throw new Error("Could not fetch anime info from Anilist");
      }

      const title = animeInfo.title.english || animeInfo.title.romaji || animeInfo.title.userPreferred;
      if (!title) {
        throw new Error("No title found for anime");
      }

      const hianimeId = await this.searchAnime(title, animeInfo);
      if (!hianimeId) {
        throw new Error("Could not find anime on Hianime");
      }

      const episodes = await this.getEpisodeIds(hianimeId, anilistId);
      return { anilistId, hianimeId, title, ...episodes };
    } catch (error: any) {
      console.error("Error in HianimeMapper:", error.message);
      throw error;
    }
  }

  private async searchAnime(_title: string, animeInfo: AnilistAnimeInfo): Promise<string | null> {
    try {
      let bestMatch = { score: 0, id: null as string | null };
      const seriesMatches: any[] = [];
      const year = animeInfo.startDate?.year || animeInfo.seasonYear;

      const titlesToTry = [
        animeInfo.title.english,
        animeInfo.title.romaji,
        ...(animeInfo.synonyms || []),
      ].filter(Boolean) as string[];

      for (const searchTitle of titlesToTry) {
        const searchUrl = `${HIANIME_BASE_URL}/search?keyword=${encodeURIComponent(searchTitle)}`;
        const response = await fetch(searchUrl);
        const html = await response.text();
        const $ = load(html);

        $(".film_list-wrap > .flw-item").each((_, item) => {
          const el = $(item).find(".film-detail .film-name a");
          const hianimeTitle = el.text().trim();
          const href = el.attr("href");
          const hianimeId = href?.split("/").pop()?.split("?")[0];
          const isTV = $(item).find(".fd-infor .fdi-item").first().text().trim() === "TV";
          const episodesText = $(item).find(".tick-item.tick-eps").text().trim();
          const episodesCount = episodesText ? parseInt(episodesText, 10) : 0;

          if (hianimeId) {
            let score = this.calculateTitleScore(searchTitle, hianimeTitle);

            if (isTV && (animeInfo.episodes || 0) > 12) score += 0.1;
            if (animeInfo.episodes && episodesCount === animeInfo.episodes) score += 0.2;
            if (year && hianimeTitle.includes(String(year))) score += 0.3;

            if (score > 0.5) {
              seriesMatches.push({ id: hianimeId, score, isTV, episodes: episodesCount });
            }

            if (score > bestMatch.score) {
              bestMatch = { score, id: hianimeId };
            }
          }
        });

        if (bestMatch.score > 0.85) return bestMatch.id;
      }

      if (seriesMatches.length > 0) {
        seriesMatches.sort((a, b) => b.score - a.score);
        return seriesMatches[0].id;
      }

      return bestMatch.score > 0.4 ? bestMatch.id : null;
    } catch (error) {
      console.error("Error searching Hianime:", error);
      return null;
    }
  }

  private async getEpisodeIds(hianimeId: string, _anilistId: number) {
    try {
      // Use internal ajax endpoint if possible, but for mapper we just need IDs
      const episodeListUrl = `${HIANIME_BASE_URL}/ajax/v2/episode/list/${hianimeId.split("-").pop()}`;
      const response = await fetch(episodeListUrl, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${HIANIME_BASE_URL}/watch/${hianimeId}`,
        },
      });
      const data = (await response.json()) as any;

      if (!data.html) return { totalEpisodes: 0, episodes: [] };

      const $ = load(data.html);
      const episodes: any[] = [];

      $("#detail-ss-list div.ss-list a").each((i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const epId = href.split("?ep=")[1];
        episodes.push({
          episodeId: `${hianimeId}?ep=${epId}`,
          number: i + 1,
          title: $(el).attr("title") || `Episode ${i + 1}`,
        });
      });

      return { totalEpisodes: episodes.length, episodes };
    } catch (error) {
      console.error("Error fetching Hianime episodes:", error);
      return { totalEpisodes: 0, episodes: [] };
    }
  }

  private calculateTitleScore(searchTitle: string, hianimeTitle: string): number {
    const normalize = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const s1 = normalize(searchTitle);
    const s2 = normalize(hianimeTitle);

    if (s1 === s2) return 1;

    const similarity = stringSimilarity.compareTwoStrings(s1, s2);
    
    // Word match score
    const words1 = s1.split(" ");
    const words2 = s2.split(" ");
    const matches = words1.filter(w => words2.includes(w)).length;
    const wordScore = matches / Math.max(words1.length, words2.length);

    return (wordScore * 0.7) + (similarity * 0.3);
  }
}
