import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getInfo, watch, search } from "./aniworld.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const SEARCH_TTL = 1_800;
const INFO_TTL = 86_400;
const SOURCES_TTL = 1_800;

export const aniworldRoutes = new Hono();

aniworldRoutes.get("/search/:q", async (c) => {
  const q = c.req.param("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `aw:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q);
  data.results = await mapProviderItems(data.results);
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

aniworldRoutes.get("/info/*", async (c) => {
  const slug = c.req.path.replace(/^\/api\/v2\/anime\/aniworld\/info\//, "");
  const key = `aw:info:${slug}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  let data = await getInfo(slug);
  data = await mapProviderItem(data);
  await Cache.set(key, JSON.stringify(data), INFO_TTL);
  return c.json(data);
});

aniworldRoutes.get("/watch/*", async (c) => {
  const path = c.req.path.replace(/^\/api\/v2\/anime\/aniworld\/watch\//, "");
  const m = path.match(/^(.+?)\/episode\/(\d+)$/);
  if (!m) return c.json({ error: "Invalid format. Expected: /watch/:slug/episode/:num" }, 400);
  
  const [, slug, episodeNum] = m;
  const key = `aw:watch:${slug}:${episodeNum}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  try {
    let data = await watch(slug, episodeNum);
    if (data.sources) {
      data.sources = await processAllSources(data.sources);
    }
    data = await mapProviderItem(data);
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
