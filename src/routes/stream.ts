import { Hono } from "hono";
import { extractCompatServers, extractCompatStreamingInfo } from "../services/hianimeCompat.js";

const streamRouter = new Hono();

streamRouter.get("/servers/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id") || "").trim();
    const ep = decodeURIComponent(c.req.query("ep") || "").trim();
    const target = ep || id;

    const servers = await extractCompatServers(target);
    return c.json({ success: true, results: servers }, 200);
});

streamRouter.get("/stream", async (c) => {
    try {
        const input = decodeURIComponent(c.req.query("id") || "").trim();
        const server = decodeURIComponent(c.req.query("server") || "HD-1").trim();
        const type = decodeURIComponent(c.req.query("type") || "sub").trim() as "sub" | "dub" | "raw";
        const ep = decodeURIComponent(c.req.query("ep") || "").trim();
        const fallback = (decodeURIComponent(c.req.query("fallback") || "false").trim() === "true");

        const finalId = ep || input.match(/ep=(\d+)/)?.[1] || input;
        if (!finalId) {
            return c.json({ success: false, message: "Invalid URL format: episode ID missing" }, 400);
        }

        const results = await extractCompatStreamingInfo(finalId, server, type, fallback);
        return c.json({ success: true, results }, 200);
    } catch (err) {
        return c.json(
            {
                success: false,
                message: (err as Error)?.message || "Failed to resolve stream",
            },
            500
        );
    }
});

streamRouter.get("/stream/fallback", async (c) => {
    const url = new URL(c.req.url);
    url.searchParams.set("fallback", "true");
    const req = new Request(url.toString(), { method: "GET", headers: c.req.raw.headers });
    return streamRouter.fetch(req, c.env, c.executionCtx);
});

export { streamRouter };
