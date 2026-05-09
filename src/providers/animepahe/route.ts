import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Animepahe } from "./animepahe.js";

export const animepaheRoutes = new Hono();

animepaheRoutes.get("/search/:query", async (c) => {
  const query = c.req.param("query");
  const results = await Animepahe.search(query);
  return c.json({ results });
});

animepaheRoutes.get("/latest", async (c) => {
  const results = await Animepahe.latest();
  return c.json({ results });
});

animepaheRoutes.get("/info/:id", async (c) => {
  const id = c.req.param("id");
  const info = await Animepahe.info(id);
  if (!info) return c.json({ error: "Anime not found" }, 404);
  return c.json(info);
});

animepaheRoutes.get("/episodes/:id", async (c) => {
  const id = c.req.param("id");
  const episodes = await Animepahe.fetchAllEpisodes(id);
  return c.json({ results: episodes });
});

animepaheRoutes.get("/episode/:id/:session", async (c) => {
  const id = c.req.param("id");
  const session = c.req.param("session");

  return stream(c, async (s) => {
    c.header("Content-Type", "application/json");
    for await (const result of Animepahe.streams(id, session)) {
      await s.write(JSON.stringify(result) + "\n");
    }
  });
});
