import { HiAnime } from "../vendor/aniwatch/index.js";

const hianime = new HiAnime.Scraper();

/**
 * Enriches response data with external IDs (anilistID, malID)
 * by attempting to fetch episode sources for the given anime
 */
export async function enrichWithExternalIds<T extends Record<string, any>>(
    data: T,
    animeId?: string
): Promise<T & { anilistID?: number | null; malID?: number | null }> {
    if (!animeId) {
        return { ...data, anilistID: null, malID: null };
    }

    try {
        // Try to get episodes first to find a valid episode ID
        const episodes = await hianime.getEpisodes(animeId);
        
        if (episodes?.episodes && episodes.episodes.length > 0) {
            const firstEpisode = episodes.episodes[0];
            const episodeId = firstEpisode.episodeId;

            if (episodeId) {
                try {
                    // Get sources for the first episode which should include external IDs
                    const sources = await hianime.getEpisodeSources(
                        episodeId,
                        HiAnime.Servers.MegaCloud,
                        "sub"
                    );

                    return {
                        ...data,
                        anilistID: sources?.anilistID ?? null,
                        malID: sources?.malID ?? null,
                    };
                } catch {
                    // If sources fail, return null IDs
                    return { ...data, anilistID: null, malID: null };
                }
            }
        }

        return { ...data, anilistID: null, malID: null };
    } catch {
        // If any error occurs during enrichment, return data with null IDs
        return { ...data, anilistID: null, malID: null };
    }
}

/**
 * Enriches an array of anime objects with external IDs
 */
export async function enrichAnimeArrayWithIds<
    T extends { id?: string; [key: string]: any }
>(animes: T[]): Promise<(T & { anilistID?: number | null; malID?: number | null })[]> {
    return Promise.all(
        animes.map((anime) => enrichWithExternalIds(anime, anime.id))
    );
}
