import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getHome, search, getInfo, watch } from "./desidubanime.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const HOME_TTL = 3_600;
const SEARCH_TTL = 1_800;
const INFO_TTL = 86_400;
const SOURCES_TTL = 1_800;

export const desidubanimeRoutes = new Hono();

desidubanimeRoutes.get("/home", async (c) => {
  const key = "ddb:home";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getHome();
  data.featured = await mapProviderItems(data.featured);
  await Cache.set(key, JSON.stringify(data), HOME_TTL);
  return c.json(data);
});

desidubanimeRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `ddb:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q);
  data.results = await mapProviderItems(data.results);
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

desidubanimeRoutes.get("/info/:id", async (c) => {
  const id = c.req.param("id");
  const key = `ddb:info:${id}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  try {
    let data = await getInfo(id);
    data = await mapProviderItem(data);
    await Cache.set(key, JSON.stringify(data), INFO_TTL);
    return c.json(data);
  } catch (e: any) {
    const status = e.message.includes("404") ? 404 : 500;
    return c.json({ error: e.message }, status as any);
  }
});

desidubanimeRoutes.get("/watch/:id", async (c) => {
  const id = c.req.param("id");
  const key = `ddb:watch:${id}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  try {
    let data = await watch(id);
    data.sources = await processAllSources(data.sources);
    data = await mapProviderItem(data);
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    const status = e.message.includes("404") ? 404 : 500;
    return c.json({ error: e.message }, status as any);
  }
});
