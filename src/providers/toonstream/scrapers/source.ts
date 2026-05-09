import * as cheerio from "cheerio";
import { PROXIFY } from "../route.js";
import { Cache } from "../../../lib/cache.js";
import { ASCDN_SOURCE_TTL, embedPlayerOrigins, RUBYSTREAM_SOURCE_TTL } from "../lib/const.js";
import { proxifySource } from "../lib/proxy.js";
import type { DirectSource } from "../lib/types.js";
import { getAsCdnSource } from "./embed/as-cdn.js";
import { getRubystmSource } from "./embed/rubystm.js";
import { browserFetch } from "../../animekai/lib/browserFetch.js";

export async function getPlayerIframeUrls(toonStreamIframeUrls: string[]) {
    const playerIframeUrls = []
    for (const url of toonStreamIframeUrls) {
        try {
            const html = await browserFetch(url, "https://toonstream.dad/");
            const $ = cheerio.load(html, { xml: true });

            const iframeUrl =
                $(".Video iframe").attr("src") ||
                $("iframe[src]").first().attr("src") ||
                $("iframe[data-src]").first().attr("data-src");
            if (!iframeUrl) continue;

            playerIframeUrls.push(iframeUrl);
        } catch (err) {
            console.log("Error:", err);
        }
    }

    console.log(`Scraped ${playerIframeUrls.length} player iframe url(s)`);
    return playerIframeUrls;
}

const { asCdnOrigin, rubyStreamOrigin } = embedPlayerOrigins

export async function getDirectSources(playerIframeUrls: string[]) {
    const directSources: DirectSource[] = [];

    for (const url of playerIframeUrls) {
        try {
            if (url.startsWith(asCdnOrigin)) {
                const key = `source:${url}`;
                const cachedSource = await Cache.get(key, true);

                if (cachedSource) {
                    directSources.push(cachedSource);
                }
                else {
                    const src = await getAsCdnSource(url);
                    if (src) {
                        Cache.set(key, src, ASCDN_SOURCE_TTL, true);
                        directSources.push(src);
                    }
                }
            }
            else if (url.startsWith(rubyStreamOrigin)) {
                const key = `source:${url}`;
                const cachedSource = await Cache.get(key, true);

                if (cachedSource) {
                    directSources.push(cachedSource);
                }
                else {
                    const src = await getRubystmSource(url);
                    if (src) {
                        Cache.set(key, src, RUBYSTREAM_SOURCE_TTL, true);
                        directSources.push(src);
                    }
                }
            }
            else
                console.log("No source-scraper found for", url, "- skipping");

        } catch (err) {
            console.log("Error:", err);
        }
    }

    console.log(`Successfully Scraped ${directSources.length} direct source(s)`);

    if (PROXIFY) {
        return directSources.map(src => proxifySource(src))
    } else {
        return directSources;
    }
}