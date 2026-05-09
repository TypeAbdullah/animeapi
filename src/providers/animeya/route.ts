import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { getHome, search, getInfo, getEpisodeSources } from "./animeya.js";
import { mapProviderItem, mapProviderItems, processAllSources } from "../../lib/universalProvider.js";

const HOME_TTL = 3_600;
const SEARCH_TTL = 1_800;
const INFO_TTL = 86_400;
const SOURCES_TTL = 1_800;

async function resolveAniListWatch(id: string, ep: string) {
  const key = `aya:watch:anilist:${id}:${ep}`;
  const cached = await Cache.get(key);
  if (cached) return JSON.parse(cached);

  const aniZipData = await fetch(`https://api.ani.zip/mappings?anilist_id=${id}`).then((r) => r.json()) as any;
  const title = aniZipData?.titles?.en || aniZipData?.titles?.romaji || "";
  if (!title) throw new Error("Could not resolve anime title from AniZip");

  const searchRes = await search(title);
  const candidates = Array.isArray(searchRes?.results) ? searchRes.results : [];
  const matched = candidates.find((r: any) => String(r?.slug || "").endsWith(`-${id}`)) || candidates[0];
  if (!matched?.slug) throw new Error("Anime not found on Animeya via AniList ID search");

  const info = await getInfo(matched.slug);
  const episodes = Array.isArray(info?.episodes) ? info.episodes : [];
  const epTarget = episodes.find((e: any) => String(e?.number) === String(ep)) || episodes[0];
  if (!epTarget?.id) throw new Error(`Episode ${ep} not found on Animeya`);

  const data = await getEpisodeSources(String(epTarget.id));
  data.sources = await processAllSources(data.sources);
  await mapProviderItem(data, "anilist_id", id);

  await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
  return data;
}

export const animeyaRoutes = new Hono();

animeyaRoutes.get("/home", async (c) => {
  const key = "aya:home";
  const cached = await Cache.get(key);
  if (cached) {
    const data = JSON.parse(cached);
    const hasCover = Array.isArray(data?.featured) && data.featured.some((x: any) => Boolean(x?.cover));
    if (hasCover) return c.json(data);
  }
  const data = await getHome();
  data.featured = await mapProviderItems(data.featured);
  data.trending = await mapProviderItems(data.trending);
  await Cache.set(key, JSON.stringify(data), HOME_TTL);
  return c.json(data);
});

animeyaRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);
  const key = `aya:search:${q}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));
  const data = await search(q);
  data.results = await mapProviderItems(data.results);
  await Cache.set(key, JSON.stringify(data), SEARCH_TTL);
  return c.json(data);
});

animeyaRoutes.get("/info/:slug", async (c) => {
  const slug = c.req.param("slug");
  const key = `aya:info:${slug}`;
  const cached = await Cache.get(key);
  if (cached) {
    const data = JSON.parse(cached);
    const looksValid = Boolean(data?.cover) || (Array.isArray(data?.episodes) && data.episodes.length > 0);
    if (looksValid) return c.json(data);
  }
  let data = await getInfo(slug);
  data = await mapProviderItem(data);
  await Cache.set(key, JSON.stringify(data), INFO_TTL);
  return c.json(data);
});

animeyaRoutes.get("/watch/:episodeId", async (c) => {
  const episodeId = c.req.param("episodeId");
  const ep = c.req.query("ep") || "1";
  const file = c.req.query("file") || "";

  const key = `aya:watch:${episodeId}:${file}`;
  const cached = await Cache.get(key);
  if (cached) return c.json(JSON.parse(cached));

  try {
    let resolvedId = episodeId;
    if (Number.isNaN(Number(episodeId))) {
      const info = await getInfo(episodeId);
      const firstEp = info?.episodes?.find((e: any) => String(e.number) === String(ep)) || info?.episodes?.[0];
      if (!firstEp?.id) return c.json({ error: "Episode ID not found for slug" }, 404);
      resolvedId = String(firstEp.id);
    }

    const data = await getEpisodeSources(resolvedId);
    data.sources = await processAllSources(data.sources);
    await mapProviderItem(data);
    
    await Cache.set(key, JSON.stringify(data), SOURCES_TTL);
    return c.json(data);
  } catch (e: any) {
    const is404 = e.message === "Status 404" || e.message === "Episode not found";
    return c.json({ error: e.message }, is404 ? 404 : 500);
  }
});

animeyaRoutes.get("/watch/anilist/:id/episode/:ep", async (c) => {
  const id = c.req.param("id");
  const ep = c.req.param("ep");

  try {
    const data = await resolveAniListWatch(id, ep);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

animeyaRoutes.get("/watch/*", async (c, next) => {
  const rawPath = c.req.path;
  const watchSegment = rawPath.includes("/watch/") ? rawPath.split("/watch/").pop() || "" : "";
  const match = watchSegment.match(/^anilist_id=(\d+)\/episode=(\d+)$/);
  if (!match) {
    return next();
  }

  const [, id, ep] = match;

  try {
    const data = await resolveAniListWatch(id, ep);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
