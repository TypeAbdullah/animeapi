import { Hono } from "hono";
import { Cache } from "../../lib/cache.js";
import { ScrapeHomePage } from "./scrapers/home.js";
import { ScrapeMovieInfo, ScrapeMovies, movieScraper } from "./scrapers/movie.js";
import { ScrapeSearch } from "./scrapers/search.js";
import { ScrapeSeries, ScrapeSeriesInfo, seriesScraper } from "./scrapers/series.js";

const HOME_CACHE_TTL = 43_200;
const SEARCH_CACHE_TTL = 43_200;
const MOVIES_PAGE_CACHE_TTL = 3600 * 24 * 30;
const SERIES_PAGE_CACHE_TTL = 3600 * 24 * 30;
const MOVIE_INFO_CACHE_TTL = 3600 * 24 * 14;
const SERIES_INFO_CACHE_TTL = 3600 * 24 * 3;
const MOVIE_SOURCES_CACHE_TTL = 3600 * 12;
const EPISODE_SOURCES_CACHE_TTL = 3600 * 12;

export const PROXIFY = true;
export const toonstreamRoutes = new Hono();

toonstreamRoutes.get("/", (c) => {
  return c.json({
    name: "toonstream-api",
    version: "0.1",
    endpoints: [
      "/toonstream/home",
      "/toonstream/search/:query/:page?",
      "/toonstream/movies/:page?",
      "/toonstream/movie/info/:slug",
      "/toonstream/movie/sources/:slug",
      "/toonstream/series/:page?",
      "/toonstream/series/info/:slug",
      "/toonstream/episode/sources/:slug",
    ],
  });
});

toonstreamRoutes.get("/home", async (c) => {
  const cachedHomeData = await Cache.get("home");
  if (cachedHomeData) return c.json(JSON.parse(cachedHomeData));

  let data = await ScrapeHomePage();
  if (data) {
    await Cache.set("home", JSON.stringify(data), HOME_CACHE_TTL);
    return c.json(data);
  }
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/search/:query/:page?", async (c) => {
  const query = c.req.param("query");
  const page = parseInt(c.req.param("page") || "1") || 1;
  const key = `search:${query}:${page}`;
  const cachedSearchData = await Cache.get(key);
  if (cachedSearchData) return c.json(JSON.parse(cachedSearchData));

  let data = await ScrapeSearch(query, page);
  if (data?.data) {
    await Cache.set(key, JSON.stringify(data), SEARCH_CACHE_TTL);
  }
  if (data) return c.json(data);
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/movies/:page?", async (c) => {
  const page = parseInt(c.req.param("page") || "1") || 1;
  const key = `movies:${page}`;
  const cachedMoviesData = await Cache.get(key);
  if (cachedMoviesData) return c.json(JSON.parse(cachedMoviesData));

  const data = await ScrapeMovies(page);
  if (data?.data) {
    await Cache.set(key, JSON.stringify(data), MOVIES_PAGE_CACHE_TTL);
  }
  if (data) return c.json(data);
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/movie/info/:slug", async (c) => {
  const slug = c.req.param("slug");
  const key = `movie:info:${slug}`;
  const cachedMovieData = await Cache.get(key);
  if (cachedMovieData) return c.json(JSON.parse(cachedMovieData));

  let data = await ScrapeMovieInfo(slug);
  if (data) {
    await Cache.set(key, JSON.stringify(data), MOVIE_INFO_CACHE_TTL);
    return c.json(data);
  }
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/movie/sources/:slug/", async (c) => {
  const slug = c.req.param("slug");
  const key = `movie:sources:${slug}`;
  const cachedData = await Cache.get(key);
  if (cachedData) return c.json(JSON.parse(cachedData));

  const data = await movieScraper(slug);
  if (data) {
    await Cache.set(key, JSON.stringify(data), MOVIE_SOURCES_CACHE_TTL);
    return c.json(data);
  }
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/series/:page?", async (c) => {
  const page = parseInt(c.req.param("page") || "1") || 1;
  const key = `series:${page}`;
  const cachedData = await Cache.get(key);
  if (cachedData) return c.json(JSON.parse(cachedData));

  const data = await ScrapeSeries(page);
  if (data?.data) {
    await Cache.set(key, JSON.stringify(data), SERIES_PAGE_CACHE_TTL);
  }
  if (data) return c.json(data);
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/series/info/:slug", async (c) => {
  const slug = c.req.param("slug");
  const key = `series:info:${slug}`;
  const cachedData = await Cache.get(key);
  if (cachedData) return c.json(JSON.parse(cachedData));

  let data = await ScrapeSeriesInfo(slug);
  if (data) {
    await Cache.set(key, JSON.stringify(data), SERIES_INFO_CACHE_TTL);
    return c.json(data);
  }
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});

toonstreamRoutes.get("/episode/sources/:slug", async (c) => {
  const slug = c.req.param("slug");
  const key = `episode:sources:${slug}`;
  const cachedData = await Cache.get(key);
  if (cachedData) return c.json(JSON.parse(cachedData));

  let data = await seriesScraper(slug);
  if (data) {
    await Cache.set(key, JSON.stringify(data), EPISODE_SOURCES_CACHE_TTL);
    return c.json(data);
  }
  return c.json({ success: false, msg: "No Data Scraped!" }, 404);
});
