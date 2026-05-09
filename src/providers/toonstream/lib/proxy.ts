import { env } from "../../../config/env.js";
const SERVER_ORIGIN = env.ANIWATCH_API_HOSTNAME ? `https://${env.ANIWATCH_API_HOSTNAME}` : "";
import type { DirectSource } from "./types.js";


const prefix = "/proxy"

export function proxifySource(source: DirectSource): DirectSource {
    const { type, url, headers } = source;
    const headerQuery = headers ? "&headers=" + encodeURIComponent(JSON.stringify(headers as Record<string, string>)) : "";

    const encodedUrl = encodeURIComponent(url);

    const finalUrl = type == "hls" ? `${SERVER_ORIGIN}${prefix}/m3u8-proxy?url=${encodedUrl}${headerQuery}` :
        `${SERVER_ORIGIN}${prefix}/mp4-proxy?url=${encodedUrl}${headerQuery}`

    return {
        proxiedUrl: finalUrl,
        ...source,
    };
}

export function proxifyUrl(url: string, type: "mp4" | "hls", headers: Record<string, string> | null = null) {
    const headerParam = headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : "";
    const proxiedUrl = type == "hls" ? `${SERVER_ORIGIN}${prefix}/m3u8-proxy?url=${encodeURIComponent(url)}${headerParam}` : "";
    return proxiedUrl;
}