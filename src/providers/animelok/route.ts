import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import {
  getHome,
  search,
  getSchedule,
  getRegionalSchedule,
  getLanguages,
  getLanguageAnime,
  getAnimeInfo,
  watch,
} from "./animelok.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const HOME_TTL = 3_600;
const SEARCH_TTL = 1_800;
const SCHEDULE_TTL = 7_200;
const LANG_TTL = 86_400;
const INFO_TTL = 86_400;
const SOURCES_TTL = 1_800;
const EMPTY_SOURCES_TTL = 30;

export const animelokRoutes = new Hono();

animelokRoutes.get("/home", async (c) => {
  const key = "lok:home";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getHome();
  if (data?.sections) {
    for (const sec of data.sections) {
      sec.items = await mapProviderItems(sec.items);
    }
  }
  await Cache.set(key, JSON.stringify(data), HOME_TTL);
  return c.json(data);
});

animelokRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `lok:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q);
  data.animes = await mapProviderItems(data.animes);
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

animelokRoutes.get("/schedule", async (c) => {
  const key = "lok:sched";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getSchedule();
  if (data?.schedule) {
    for (const d of data.schedule) {
      d.anime = await mapProviderItems(d.anime);
    }
  }
  await Cache.set(key, JSON.stringify(data), SCHEDULE_TTL);
  return c.json(data);
});

animelokRoutes.get("/regional-schedule", async (c) => {
  const key = "lok:rsched";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getRegionalSchedule();
  if (data?.schedule) {
    for (const d of data.schedule) {
      d.anime = await mapProviderItems(d.anime);
    }
  }
  await Cache.set(key, JSON.stringify(data), SCHEDULE_TTL);
  return c.json(data);
});

animelokRoutes.get("/languages", async (c) => {
  const page = c.req.query("page") || "1";
  const key = `lok:langs:${page}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getLanguages(page);
  await Cache.set(key, JSON.stringify(data), LANG_TTL);
  return c.json(data);
});

animelokRoutes.get("/languages/:language", async (c) => {
  const language = c.req.param("language");
  const page = c.req.query("page") || "1";
  const key = `lok:lang:${language}:${page}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getLanguageAnime(language, page);
  data.anime = await mapProviderItems(data.anime);
  await Cache.set(key, JSON.stringify(data), LANG_TTL);
  return c.json(data);
});

animelokRoutes.get("/anime/:id", async (c) => {
  const id = c.req.param("id");
  const key = `lok:anime:${id}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  let data = await getAnimeInfo(id);
  data = await mapProviderItem(data);
  await Cache.set(key, JSON.stringify(data), INFO_TTL);
  return c.json(data);
});

animelokRoutes.get("/watch/:id", async (c) => {
  const id = c.req.param("id");
  const ep = c.req.query("ep") || "1";
  const anilistHint = String(c.req.query("anilistId") || "").trim();
  const malHint = String(c.req.query("malId") || "").trim();
  const forceRefresh = c.req.query("refresh") === "1" || c.req.query("noCache") === "1";
  const key = `lok:watch:${id}:${ep}:anilist:${anilistHint || "0"}:mal:${malHint || "0"}`;
  if (!forceRefresh) {
    const cached = await Cache.get(key);
    if (cached) return c.json(JSON.parse(cached));
  }
  try {
    let data = await watch(id, ep, anilistHint || undefined, malHint || undefined);
    data = await mapProviderItem(data);
    if (data.servers) {
      data.servers = await processAllSources(data.servers);
    }
    const hasSources = Array.isArray(data?.servers) && data.servers.length > 0;
    await Cache.set(key, JSON.stringify(data), hasSources ? SOURCES_TTL : EMPTY_SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
