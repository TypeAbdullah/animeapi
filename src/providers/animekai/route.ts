import { Hono } from "hono";
import { AnimeKai } from "./animekai.js";

export const animekaiRoutes = new Hono();

animekaiRoutes.get("/search/:query", async (c) => {
  const query = c.req.param("query");
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.search(query, page));
});

animekaiRoutes.get("/spotlight", async (c) => {
  return c.json({ results: await AnimeKai.spotlight() });
});

animekaiRoutes.get("/schedule/:date", async (c) => {
  const date = c.req.param("date");
  return c.json({ results: await AnimeKai.schedule(date) });
});

animekaiRoutes.get("/suggestions/:query", async (c) => {
  const query = c.req.param("query");
  return c.json({ results: await AnimeKai.suggestions(query) });
});

animekaiRoutes.get("/recent-episodes", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.recentlyUpdated(page));
});

animekaiRoutes.get("/recent-added", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.recentlyAdded(page));
});

animekaiRoutes.get("/completed", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.latestCompleted(page));
});

animekaiRoutes.get("/new-releases", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.newReleases(page));
});

animekaiRoutes.get("/movies", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.movies(page));
});

animekaiRoutes.get("/tv", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.tv(page));
});

animekaiRoutes.get("/ova", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.ova(page));
});

animekaiRoutes.get("/ona", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.ona(page));
});

animekaiRoutes.get("/specials", async (c) => {
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.specials(page));
});

animekaiRoutes.get("/genres", async (c) => {
  return c.json({ results: await AnimeKai.genres() });
});

animekaiRoutes.get("/genre/:genre", async (c) => {
  const genre = c.req.param("genre");
  const page = parseInt(c.req.query("page") || "1") || 1;
  return c.json(await AnimeKai.genreSearch(genre, page));
});

animekaiRoutes.get("/info/:id?", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ message: "id is required" }, 400);
  const res = await AnimeKai.info(id);
  if (!res) return c.json({ message: "Anime not found" }, 404);
  return c.json(res);
});

animekaiRoutes.get("/watch/:episodeId", async (c) => {
  const episodeId = c.req.param("episodeId");
  if (!episodeId) return c.json({ message: "episodeId is required" }, 400);
  const dubParam = c.req.query("dub");
  const subOrDub: "softsub" | "dub" = (dubParam === "true" || dubParam === "1") ? "dub" : "softsub";

  const results = await AnimeKai.streams(episodeId, subOrDub);
  return c.json({ results });
});

animekaiRoutes.get("/servers/:episodeId", async (c) => {
  const episodeId = c.req.param("episodeId");
  if (!episodeId) return c.json({ message: "episodeId is required" }, 400);
  const dubParam = c.req.query("dub");
  const subOrDub: "softsub" | "dub" = (dubParam === "true" || dubParam === "1") ? "dub" : "softsub";
  return c.json({ servers: await AnimeKai.fetchEpisodeServers(episodeId, subOrDub) });
});
