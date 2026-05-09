import { cors } from "hono/cors";


export const corsConfig = cors({
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
    credentials: true,
    origin: (origin) => origin || "*",
});
