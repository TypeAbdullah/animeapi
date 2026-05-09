import * as cheerio from "cheerio";
import { TOONSTREAM_BASE } from "../lib/const.js";
import type { AnimeCard, LastEpisode, MainSection, SidebarSection } from "../lib/types.js";
import { browserFetch } from "../../animekai/lib/browserFetch.js";
export async function ScrapeHomePage() {
    try {
        const url = TOONSTREAM_BASE + "/home/"
        const html = await browserFetch(url, TOONSTREAM_BASE + "/");
        const $ = cheerio.load(html);


        /*  SIDEBAR */
        const sidebarSections: SidebarSection[] = [];
        try {
            $("aside.sidebar section").each((_, section) => {
                const sectionTitle = $(section).find("h3.section-title").text();
                if (!sectionTitle) return;

                const data: AnimeCard[] = [];
                $(section).find("ul li").each((_, item) => {
                    try {
                        const title = $(item).find("article header h2.entry-title").text()
                        const url = $(item).find("article a").attr("href");
                        const poster = $(item).find("article .post-thumbnail img").attr("src");
                        if (!url || !poster) return;
                        const type = url.includes("/series") ? "series" : "movie";
                        const tmdbRating = Number($(item).find("article header .vote").text().replace("TMDB", "").trim()) || 0;
                        const slug = url.split("/").filter(Boolean).pop();
                        data.push({ type, title, slug: slug || "", poster, url, tmdbRating })
                    } catch (e) { /* skip */ }
                });
                sidebarSections.push({ label: sectionTitle, data });
            });
        } catch (e) { console.error(`[Sidebar Error] ${e}`); }

        // LAST EPISODES 
        const lastEpisodes: LastEpisode[] = [];
        try {
            $("main .widget_list_episodes ul li").each((_, ep) => {
                const url = $(ep).find("a").attr("href");
                const thumbnail = $(ep).find("img").attr("src");
                if (!url || !thumbnail) return;
                const slug = url.split("/").filter(Boolean).pop();
                const title = $(ep).find("header h2.entry-title").text();
                const epXseason = $(ep).find("header .num-epi").text();
                const ago = $(ep).find("header .time").text();
                lastEpisodes.push({ title, slug: slug || "", url, epXseason, ago, thumbnail })
            });
        } catch (e) { console.error(`[LastEP Error] ${e}`); }

        // MAIN SECTIONS
        const mainSections: MainSection[] = []
        try {
            $("main section.movies").each((_, sect) => {
                const sectionTitle = $(sect).find("header .section-title").text();
                const viewMoreUrl = $(sect).find("header a").attr("href");
                const data: AnimeCard[] = []
                $(sect).find(".aa-cn ul li").each((_, item) => {
                    try {
                        const title = $(item).find("article header h2.entry-title").text()
                        const url = $(item).find("article a").attr("href") || "";
                        const poster = $(item).find("article .post-thumbnail img").attr("src") || "";
                        if (!url || !poster) return;
                        const type = url.includes("/series") ? "series" : "movie";
                        const tmdbRating = Number($(item).find("article header .vote").text().replace("TMDB", "").trim()) || 0;
                        const slug = url.split("/").filter(Boolean).pop();
                        data.push({ type, title, slug: slug || "", poster, url, tmdbRating })
                    } catch (e) { /* skip */ }
                });
                mainSections.push({ label: sectionTitle, viewMore: viewMoreUrl, data });
            })
        } catch (e) { console.error(`[Main Error] ${e}`); }

        return {
            main: mainSections,
            sidebar: sidebarSections,
            lastEpisodes
        }
    } catch (err) {
        console.log("Error", err)
    }
}

// Bun.write(`logs/${Date.now()}`, JSON.stringify(await ScrapeHome()))