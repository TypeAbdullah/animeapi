import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { Logger } from "../../utils/logger.js";
import { getEpisode } from "./techinmind.js";
import { mapProviderItem, processAllSources } from "../../lib/universalProvider.js";

const SOURCES_TTL = 1_800;

export const techinmindRoutes = new Hono();

techinmindRoutes.get("/episode", async (c) => {
  const tmdbId = c.req.query("tmdbId");
  const malId = c.req.query("malId");
  const anilistId = c.req.query("anilistId");
  const season = c.req.query("season") || "1";
  const episode = c.req.query("episode") || "1";
  const type = c.req.query("type") || "series";

  if (!tmdbId && !malId && !anilistId) {
    return c.json({ error: "Provide tmdbId, malId, or anilistId" }, 400);
  }
  if (type !== "movie" && (!season || !episode)) {
    return c.json({ error: "Missing season or episode" }, 400);
  }

  const idKey = tmdbId || malId || anilistId;
  const key = `techinmind:ep:${idKey}:${season}:${episode}:${type}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));

  try {
    let data = await getEpisode({ tmdbId, malId, anilistId, season, episode, type }) as any;
    if (data.streams) {
      data.streams = await processAllSources(data.streams);
    }
    if (anilistId) await mapProviderItem(data, 'anilist_id', anilistId);
    else if (malId) await mapProviderItem(data, 'mal_id', malId);
    else if (tmdbId) await mapProviderItem(data, 'tmdb_id', tmdbId);
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    const msg = e?.message || "Techinmind upstream error";
    const isNotFound = msg.includes("[NOT_FOUND]") || msg.includes("Could not resolve TMDB ID");
    const status = isNotFound ? 404 : 502;
    Logger.error(`[Techinmind] ${msg}`);
    return c.json({ error: msg.replace(/\[NOT_FOUND\]\s*/, "") }, status as any);
  }
});

techinmindRoutes.get("/proxy", async (c) => {
  const url = c.req.query("url");
  const referer = c.req.query("referer");

  if (!url) return c.json({ error: "Missing url" }, 400);

  try {
    const headers: Record<string, string> = {};
    if (referer) headers["Referer"] = referer;
    headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

    const res = await fetch(url, { headers });
    const blob = await res.blob();
    
    return c.body(blob.stream(), {
        status: res.status,
        headers: {
            "Content-Type": res.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
        }
    } as any);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
