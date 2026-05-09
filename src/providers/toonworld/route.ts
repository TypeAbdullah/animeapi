import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getEpisodeSources, search } from "./toonworld.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const SEARCH_TTL = 1_800;
const SOURCES_TTL = 1_800;

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const toonworldRoutes = new Hono();

toonworldRoutes.get("/search/:q", async (c) => {
  const q = c.req.param("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `tw:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q) as any;
  const results = await mapProviderItems(data);
  await Cache.set(key, JSON.stringify(results), SEARCH_TTL);
  return c.json(results);
});

toonworldRoutes.get("/episode", async (c) => {
  const slug = c.req.query("slug");
  const animeName = c.req.query("anime");
  const seasonStr = c.req.query("season") || "1";
  const episodeStr = c.req.query("episode");

  if (!slug && !animeName) return c.json({ error: "Missing slug or anime parameter" }, 400);
  if (!episodeStr) return c.json({ error: "Missing episode parameter" }, 400);

  const animeSlug = (slug as string) || slugify((animeName as string) || "");
  const season = parseInt(seasonStr, 10) || 1;
  const episode = parseInt(episodeStr, 10);

  if (isNaN(episode)) return c.json({ error: "Invalid episode number" }, 400);

  const key = `tw:ep:${animeSlug}:${season}:${episode}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));

  try {
    let data = await getEpisodeSources(animeSlug, season, episode);
    data.sources = await processAllSources(data.sources);
    data = await mapProviderItem(data);
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
