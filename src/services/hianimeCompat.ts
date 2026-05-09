import axios from "axios";
import * as cheerio from "cheerio";

type StreamType = "sub" | "dub" | "raw";

export type CompatServer = {
    type: StreamType;
    data_id: string;
    server_id: string;
    serverName: string;
};

export type CompatStreamResults = {
    streamingLink: Array<{
        link: string;
        type: string;
        server: string;
        iframe: string;
    }>;
    tracks: Array<{
        file: string;
        label?: string;
        kind?: string;
        default?: boolean;
    }>;
    intro: { start: number; end: number } | null;
    outro: { start: number; end: number } | null;
    server: string;
    servers: CompatServer[];
};

const V1_BASE = "aniwatchtv.to";
const V4_BASE = "9animetv.to";
const FALLBACK_HD1 = "megaplay.buzz";
const FALLBACK_HD2 = "vidwish.live";
const BLOCKED_HOST_MARKERS = ["douvid.xyz", "haildrop77.pro", "fxpy7.watching.onl"];

const containsBlockedHost = (value: unknown): boolean => {
    const normalized = String(value || "").toLowerCase();
    if (!normalized) return false;
    return BLOCKED_HOST_MARKERS.some((marker) => normalized.includes(marker));
};

const normalizeServerName = (name: string): string => {
    const serverName = name.trim().toLowerCase();
    switch (serverName) {
        case "megacloud":
        case "rapidcloud":
        case "hd-1":
            return "HD-1";
        case "vidsrc":
        case "vidstreaming":
        case "hd-2":
            return "HD-2";
        case "t-cloud":
        case "hd-3":
            return "HD-3";
        default:
            return name;
    }
};

export async function extractCompatServers(id: string): Promise<CompatServer[]> {
    try {
        const resp = await axios.get(
            `https://${V1_BASE}/ajax/v2/episode/servers?episodeId=${id}`
        );
        const $ = cheerio.load(resp.data.html);
        const serverData: CompatServer[] = [];

        $(".server-item").each((_, element) => {
            const data_id = String($(element).attr("data-id") || "");
            const server_id = String($(element).attr("data-server-id") || "");
            const type = String($(element).attr("data-type") || "sub") as StreamType;
            const originalName = $(element).find("a").text().trim();

            if (containsBlockedHost(originalName)) {
                return;
            }

            serverData.push({
                type,
                data_id,
                server_id,
                serverName: normalizeServerName(originalName),
            });
        });

        return serverData;
    } catch {
        return [];
    }
}

async function decryptSourcesCompat(
    epID: string,
    id: string,
    name: string,
    type: StreamType,
    fallback: boolean
) {
    try {
        let decryptedSources: any = null;
        let iframeURL = "";

        if (fallback) {
            const fallbackServer = ["hd-1", "hd-3"].includes(name.toLowerCase())
                ? FALLBACK_HD1
                : FALLBACK_HD2;

            iframeURL = `https://${fallbackServer}/stream/s-2/${epID}/${type}`;

            const { data } = await axios.get(iframeURL, {
                headers: { Referer: `https://${fallbackServer}/` },
            });

            const $ = cheerio.load(data);
            const dataId = $("#megaplay-player").attr("data-id");
            const { data: decryptedData } = await axios.get(
                `https://${fallbackServer}/stream/getSources?id=${dataId}`,
                { headers: { "X-Requested-With": "XMLHttpRequest" } }
            );
            decryptedSources = decryptedData;
        } else {
            const { data: sourcesData } = await axios.get(
                `https://${V4_BASE}/ajax/episode/sources?id=${id}`,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                }
            );

            const ajaxLink = sourcesData?.link;
            if (!ajaxLink) return null;
            iframeURL = ajaxLink;

            const sourceIdMatch = /\/([^/?]+)\?/.exec(ajaxLink);
            const sourceId = sourceIdMatch?.[1];
            if (!sourceId) return null;

            const baseUrlMatch = ajaxLink.match(/^(https?:\/\/[^\/]+(?:\/[^\/]+){3})/);
            if (!baseUrlMatch) return null;
            const baseUrl = baseUrlMatch[1];

            const sourcesUrl = `${baseUrl}/getSources?id=${sourceId}`;
            const { data: directData } = await axios.get(sourcesUrl, {
                headers: {
                    Accept: "*/*",
                    "X-Requested-With": "XMLHttpRequest",
                    Referer: `${ajaxLink}&autoPlay=1&oa=0&asi=1`,
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    Origin: baseUrl.match(/^https?:\/\/[^\/]+/)?.[0] || "",
                },
            });

            decryptedSources = directData;
        }

        const streamFile = fallback
            ? decryptedSources?.sources?.file || ""
            : Array.isArray(decryptedSources?.sources)
                ? decryptedSources?.sources?.[0]?.file || ""
                : typeof decryptedSources?.sources === "object"
                    ? decryptedSources?.sources?.file || ""
                    : "";

        if (containsBlockedHost(streamFile) || containsBlockedHost(iframeURL)) {
            return null;
        }

        return {
            link: {
                file: streamFile,
                type: "hls",
            },
            tracks: decryptedSources?.tracks || [],
            intro: decryptedSources?.intro || null,
            outro: decryptedSources?.outro || null,
            iframe: iframeURL,
            server: name,
        };
    } catch {
        return null;
    }
}

export async function extractCompatStreamingInfo(
    id: string,
    name: string,
    type: StreamType,
    fallback = false
): Promise<CompatStreamResults> {
    const servers = await extractCompatServers(id.split("?ep=").pop() || id);

    let requestedServer = servers.filter(
        (server) =>
            server.serverName.toLowerCase() === name.toLowerCase() &&
            server.type.toLowerCase() === type.toLowerCase()
    );

    if (requestedServer.length === 0) {
        requestedServer = servers.filter(
            (server) =>
                server.serverName.toLowerCase() === name.toLowerCase() &&
                server.type.toLowerCase() === "raw"
        );
    }

    if (requestedServer.length === 0) {
        requestedServer = servers.filter(
            (server) => server.type.toLowerCase() === type.toLowerCase()
        );
    }

    if (requestedServer.length === 0 && servers.length > 0) {
        requestedServer = [servers[0]];
    }

    if (requestedServer.length === 0) {
        return {
            streamingLink: [],
            tracks: [],
            intro: null,
            outro: null,
            server: normalizeServerName(name),
            servers: [],
        };
    }

    const selected = requestedServer[0];
    const streamingLink = await decryptSourcesCompat(
        id,
        selected.data_id,
        selected.serverName,
        selected.type,
        fallback
    );

    if (!streamingLink) {
        return {
            streamingLink: [],
            tracks: [],
            intro: null,
            outro: null,
            server: selected.serverName,
            servers,
        };
    }

    return {
        streamingLink: [
            {
                link: streamingLink.link.file,
                type: streamingLink.link.type,
                server: streamingLink.server,
                iframe: streamingLink.iframe,
            },
        ],
        tracks: streamingLink.tracks || [],
        intro: streamingLink.intro || null,
        outro: streamingLink.outro || null,
        server: streamingLink.server,
        servers,
    };
}
