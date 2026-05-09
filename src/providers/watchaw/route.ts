import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getHome, search, getEpisodeSources } from "./watchaw.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const BETA_MAPPING_ENABLED = process.env.Beta_Mapping === "true";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_AUTH_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const HOME_TTL = 3_600;
const SEARCH_TTL = 1_800;
const SOURCES_TTL = 1_800;

export const watchawRoutes = new Hono();

watchawRoutes.get("/home", async (c) => {
  const key = "waw:home";
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await getHome();
  data.featured = await mapProviderItems(data.featured);
  await Cache.set(key, JSON.stringify(data), HOME_TTL);
  return c.json(data);
});

watchawRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `waw:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q);
  data.results = await mapProviderItems(data.results);
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

watchawRoutes.get("/episode", async (c) => {
  let id = (c.req.query("id") || c.req.query("episodeUrl")) as string;
  const anilist_id = c.req.query("anilist_id") as string;
  const episodeNum = c.req.query("episode") as string;

  if (!id && anilist_id && episodeNum && BETA_MAPPING_ENABLED) {
    try {
      const aniZipData = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilist_id}`).then(r => r.json()) as any;
      const title = aniZipData?.titles?.en || aniZipData?.titles?.romaji || "";
      if (title) {
        const searchRes = await search(title);
        const matched = searchRes.results?.[0];
        if (matched && matched.slug) {
          id = `${matched.slug}-1-${episodeNum}`;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  if (!id) return c.json({ error: "Missing id/episodeUrl or anilist_id+episode parameters" }, 400);
  const key = `waw:ep:${id}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  try {
    let data = await getEpisodeSources(id, SUPABASE_URL, SUPABASE_AUTH_KEY);
    data.sources = await processAllSources(data.sources);
    if (anilist_id) {
      await mapProviderItem(data, 'anilist_id', anilist_id);
    } else {
      await mapProviderItem(data);
    }
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    const status = e.message.includes("404") ? 404 : 500;
    return c.json({ error: e.message }, status as any);
  }
});
