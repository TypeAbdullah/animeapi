import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getHome, getCategory, search, getAnime, extractEpisodeHls } from "./hindidubbed.js";
import { mapProviderItem, mapProviderItems } from "../../lib/universalProvider.js";

const HOME_TTL = 3_600;
const SEARCH_TTL = 1_800;
const INFO_TTL = 86_400;

export const hindidubbedRoutes = new Hono();

hindidubbedRoutes.get("/home", async (c) => {
  const key = "hdb:home";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  let data = await getHome() as any;
  if (data?.featured) {
    data.featured = await mapProviderItems(data.featured);
  }
  await Cache.set(key, JSON.stringify(data), HOME_TTL);
  return c.json(data);
});

hindidubbedRoutes.get("/category/:name", async (c) => {
  const name = c.req.param("name");
  const key = `hdb:cat:${name}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  let data = await getCategory(name) as any;
  if (data?.anime) {
    data.anime = await mapProviderItems(data.anime);
  }
  await Cache.set(key, JSON.stringify(data), INFO_TTL);
  return c.json(data);
});

hindidubbedRoutes.get("/search/:title", async (c) => {
  const title = c.req.param("title");
  if (!title) return c.json({ error: "Missing title parameter" }, 400);
  const key = `hdb:search:${title}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  let data = await search(title) as any;
  if (data?.animeList) {
    data.animeList = await mapProviderItems(data.animeList);
  }
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

hindidubbedRoutes.get("/anime/:slug", async (c) => {
  const slug = c.req.param("slug");
  const key = `hdb:anime:${slug}`;
  const cached = await Cache.get(key);
  if (cached) {
    const data = JSON.parse(cached);
    const looksValid = Array.isArray(data?.episodes) && data.episodes.length > 0;
    if (looksValid) return c.json(data);
  }
  let data = await getAnime(slug);
  data = await mapProviderItem(data);
  await Cache.set(key, JSON.stringify(data), INFO_TTL);
  return c.json(data);
});

hindidubbedRoutes.get("/episode", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "Missing url parameter" }, 400);

  try {
    const data = await extractEpisodeHls(url);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to extract episode" }, 500);
  }
});

hindidubbedRoutes.get("/episode/hls", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "Missing url parameter" }, 400);

  const serverName = c.req.query("server")?.toLowerCase();
  if (serverName && serverName.includes("abyss")) {
    return c.json({ error: "Servabyss extraction is intentionally disabled" }, 400);
  }

  try {
    const data = await extractEpisodeHls(url);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to extract HLS" }, 500);
  }
});
