import { Logger } from "../../utils/logger.js";
import * as crypto from "crypto";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const TECHINMIND_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "User-Agent": UA,
  Referer: "https://stream.techinmind.space/",
  Origin: "https://stream.techinmind.space",
  "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

const URL_SUFFIXES: Record<string, string> = {
  plrx: "/",
  stmrb: ".html",
  strmtp: "/",
  dpld: "?srv10.dropload.io/i/01/00118/uv0mx9c9xicj",
};

const FILE_SLUG_API_KEY = "e11a7debaaa4f5d25b671706ffe4d2acb56efbd4";

// ── Types ─────────────────────────────────────────────────────────────
export interface EmbedStream {
  provider: string;
  id: string;
  url: string;
  dhls?: string;
  phls?: string;
  headers?: Record<string, string>;
}

export interface HindiApiResult {
  meta: { tmdbId: string; season: string; episode: string; slug: string };
  streams: EmbedStream[];
}

// ── Step 1: File Slug ─────────────────────────────────────────────────
export async function getFileSlug(tmdbId: string, season: string, episode: string, type = "series"): Promise<string> {
  const isMovie = type === "movie";
  const base = isMovie
    ? "https://stream.techinmind.space/mymovieapi"
    : "https://stream.techinmind.space/myseriesapi";

  const params = new URLSearchParams({ tmdbid: tmdbId, key: FILE_SLUG_API_KEY });
  if (!isMovie) { params.set("season", season); params.set("epname", episode); }

  const url = `${base}?${params}`;
  Logger.info(`[HindiAPI] Step1 slug: ${url}`);

  let res = await fetch(url, { headers: TECHINMIND_HEADERS, signal: AbortSignal.timeout(10000) });
  if (res.status === 403) {
    Logger.warn("[HindiAPI] Step1 403, trying CORS proxy");
    res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
  }
  if (!res.ok) throw new Error(`[NOT_FOUND] Slug API returned ${res.status}`);

  const data: any = await res.json();
  if (Array.isArray(data.data) && data.data[0]?.fileslug) return data.data[0].fileslug;
  if (data.data?.fileslug) return data.data.fileslug;
  throw new Error("[NOT_FOUND] File slug not found in response");
}

// ── Step 2: Embed Data ────────────────────────────────────────────────
export async function getEmbedData(fileSlug: string): Promise<any> {
  const url = "https://ssn.techinmind.space/embedhelper.php";
  const refererDomain = "pro.iqsmartgames.com";
  const body = new URLSearchParams();
  body.append("sid", fileSlug);
  body.append("UserFavSite", "");
  body.append("currentDomain", JSON.stringify([refererDomain, refererDomain]));

  Logger.info(`[HindiAPI] Step2 embed for slug: ${fileSlug}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: `https://${refererDomain}/`,
      Origin: `https://${refererDomain}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Embed API returned ${res.status}`);
  const data: any = await res.json();
  if (!data.mresult) throw new Error("No mresult in embed response");
  return data;
}

// ── Step 3: Process Embed ─────────────────────────────────────────────
export function processEmbedData(data: any): EmbedStream[] {
  const { mresult, siteUrls, siteFriendlyNames } = data;
  let decoded: Record<string, string>;
  try {
    decoded = JSON.parse(Buffer.from(mresult, "base64").toString("utf-8"));
  } catch {
    Logger.error("[HindiAPI] Failed to decode mresult");
    return [];
  }
  const results: EmbedStream[] = [];
  for (const [key, id] of Object.entries(decoded)) {
    const name = siteFriendlyNames?.[key] ?? key;
    const base = siteUrls?.[key] ?? "";
    const suffix = URL_SUFFIXES[key] || "";
    if (base) results.push({ provider: name, id, url: `${base}${id}${suffix}` });
  }
  return results;
}

// ── HLS Extractors ────────────────────────────────────────────────────
const UPNS_KEY_HEX = "6b69656d7469656e6d75613931316361";

function decryptUpns(encHex: string, keyHex: string): string | null {
  try {
    const key = Buffer.from(keyHex, "hex");
    const full = Buffer.from(encHex.trim(), "hex");
    if (full.length < 16) return null;
    const iv = full.subarray(0, 16);
    const ct = full.subarray(16);
    const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf-8");
  } catch { return null; }
}

async function extractUpns(playerUrl: string) {
  try {
    const u = new URL(playerUrl);
    const base = `${u.protocol}//${u.host}`;
    const headers = { "User-Agent": UA, Referer: `${base}/` };

    let videoId: string | null = playerUrl.match(/#([a-zA-Z0-9]+)$/)?.[1] || null;
    if (!videoId) videoId = u.searchParams.get("id") || u.searchParams.get("video");
    if (!videoId) videoId = playerUrl.match(/\/([a-zA-Z0-9]{5,})(?:\/|$|#)/)?.[1] || null;
    if (!videoId) return null;

    const res = await fetch(`${base}/api/v1/video?id=${videoId}&w=1920&h=1200&r=`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const dec = decryptUpns(text, UPNS_KEY_HEX);
    if (!dec) return null;
    const m = dec.match(/"source"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    let url = m[1].replace(/\\\//g, "/");
    if (!url.startsWith("http")) url = new URL(url, base).toString();
    return { streamUrl: url, headers: { ...headers, Origin: base } };
  } catch { return null; }
}

function decodePrintable95(hex: string, shift: number): string {
  try {
    const mid = Buffer.from(hex, "hex").toString("latin1");
    let out = "";
    for (let i = 0; i < mid.length; i++) {
      const s = mid.charCodeAt(i) - 32;
      const r = (s - shift - i) % 95;
      out += String.fromCharCode(r + 32);
    }
    return out;
  } catch { return ""; }
}

async function extractStrmup(playerUrl: string) {
  try {
    const res = await fetch(playerUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const u = new URL(playerUrl);
    const base = `${u.protocol}//${u.host}`;
    let streamUrl: string | null = null;

    if (html.includes("decodePrintable95")) {
      const em = html.match(/decodePrintable95\("([a-f0-9]+)"/);
      const sm = html.match(/__enc_shift\s*=\s*(\d+)/);
      if (em && sm) streamUrl = decodePrintable95(em[1], parseInt(sm[1]));
    }
    if (!streamUrl) {
      const mediaId = playerUrl.split("/").pop();
      try {
        const sRes = await fetch(`${base}/ajax/stream?filecode=${mediaId}`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(5000),
        });
        const j: any = await sRes.json();
        if (j?.streaming_url) streamUrl = j.streaming_url;
      } catch {}
    }
    if (streamUrl) return { streamUrl, headers: { "User-Agent": UA, Referer: `${base}/`, Origin: base } };
    return null;
  } catch { return null; }
}

function ft(e: string): Buffer {
  const t = e.replace(/-/g, "+").replace(/_/g, "/");
  const r = t.length % 4 === 0 ? 0 : 4 - (t.length % 4);
  return Buffer.from(t + "=".repeat(r), "base64");
}

async function extractBsye(url: string) {
  try {
    const m = url.match(/\/(?:e|d)\/([0-9a-zA-Z]+)/);
    if (!m) return null;
    const mediaId = m[1];
    const host = new URL(url).host;
    const res = await fetch(`https://${host}/api/videos/${mediaId}/embed/playback`, {
      headers: { "User-Agent": UA, Referer: url, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json();
    let sources = json?.sources;
    if (!sources && json?.playback) {
      try {
        const pd = json.playback;
        const iv = ft(pd.iv);
        const key = Buffer.concat([pd.key_parts[0], pd.key_parts[1], pd.key_parts[2], pd.key_parts[3]].map(ft));
        const payload = ft(pd.payload);
        const tagLen = 16;
        const ct = payload.subarray(0, payload.length - tagLen);
        const tag = payload.subarray(payload.length - tagLen);
        const d = crypto.createDecipheriv("aes-256-gcm", key, iv) as crypto.DecipherGCM;
        d.setAuthTag(tag);
        sources = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8")).sources;
      } catch {}
    }
    if (sources?.length > 0) {
      const hls = sources.find((s: any) => (s.file || s.url || s.src || "").includes(".m3u8")) || sources[0];
      const fileUrl = hls.file || hls.url || hls.src;
      if (fileUrl) return { streamUrl: fileUrl, headers: { "User-Agent": UA, Referer: `https://${host}/`, Origin: `https://${host}` } };
    }
    return null;
  } catch { return null; }
}

function unpack(packed: string): string | null {
  try {
    const start = packed.indexOf("}('");
    if (start === -1) return null;
    const splitIdx = packed.lastIndexOf(".split('|')");
    if (splitIdx === -1) return null;
    const body = packed.substring(start + 2, splitIdx);
    const sepRx = /',(\d+),(\d+),'/g;
    let lm: RegExpExecArray | null = null, m: RegExpExecArray | null;
    while ((m = sepRx.exec(body)) !== null) lm = m;
    if (!lm) return null;
    const radix = parseInt(lm[1]), count = parseInt(lm[2]);
    const payload = body.substring(0, lm.index);
    const kws = body.substring(lm.index + lm[0].length, body.length - 1).split("|");
    const dec = (c: number): string => (c < radix ? "" : dec(Math.floor(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
    let out = payload;
    for (let i = count - 1; i >= 0; i--) {
      if (kws[i]) out = out.replace(new RegExp("\\b" + dec(i) + "\\b", "g"), kws[i]);
    }
    return out;
  } catch { return null; }
}

async function extractSwish(playerUrl: string) {
  try {
    const res = await fetch(playerUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    let streamUrl: string | null = null;
    const packed = html.match(/eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\)\)\)/)?.[0];
    if (packed) { const u = unpack(packed); if (u) { const m = u.match(/https?:\/\/[^"']+\.m3u8[^"']*/); if (m) streamUrl = m[0]; } }
    if (!streamUrl) { const m = html.match(/https?:\/\/[^"']+\.m3u8[^"']*/); if (m) streamUrl = m[0]; }
    if (streamUrl) return { streamUrl: streamUrl.replace(/\\/g, ""), headers: { "User-Agent": UA, Referer: playerUrl, Origin: new URL(playerUrl).origin } };
    return null;
  } catch { return null; }
}

async function extractGeneric(playerUrl: string) {
  try {
    const res = await fetch(playerUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    const html = (await res.text()).replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    const m = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/);
    if (m) return { streamUrl: m[1], headers: { "User-Agent": UA, Referer: playerUrl } };
    return null;
  } catch { return null; }
}

export async function extractUniversal(playerUrl: string) {
  if (!playerUrl) return null;
  try {
    const hostname = new URL(playerUrl).hostname;
    if (hostname.includes("uns.bio") || hostname.includes("upns.one") || hostname.includes("rpmhub.site") || hostname.includes("p2pplay.pro")) {
      return await extractUpns(playerUrl);
    }
    if (hostname.includes("strmup") || hostname.includes("streamup")) return await extractStrmup(playerUrl);
    if (hostname.includes("multimoviesshg.com")) { const r = await extractSwish(playerUrl); if (r) return r; }
    if (playerUrl.includes("/e/") || playerUrl.includes("/d/")) { const r = await extractBsye(playerUrl); if (r) return r; }
    return await extractGeneric(playerUrl);
  } catch { return null; }
}

const normalizeTmdbId = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
  }
  return null;
};

// ── TMDB ID Resolution ────────────────────────────────────────────────
export async function resolveToTmdbId(params: { tmdbId?: string; malId?: string; anilistId?: string }): Promise<string | null> {
  if (params.tmdbId) return params.tmdbId;

  if (params.anilistId) {
    try {
      const aniZipUrl = `https://api.ani.zip/mappings?anilist_id=${params.anilistId}`;
      Logger.info(`[HindiAPI] Resolving TMDB via AniZip: ${aniZipUrl}`);

      const aniZipRes = await fetch(aniZipUrl, { signal: AbortSignal.timeout(5000) });
      if (aniZipRes.ok) {
        const aniZipData: any = await aniZipRes.json();
        const tmdbFromAniZip = normalizeTmdbId(
          aniZipData?.mappings?.themoviedb_id ??
            aniZipData?.mappings?.tmdb_id ??
            aniZipData?.themoviedb_id ??
            aniZipData?.tmdb_id
        );

        if (tmdbFromAniZip) {
          Logger.info(`[HindiAPI] TMDB resolved via AniZip: ${tmdbFromAniZip}`);
          return tmdbFromAniZip;
        }
      }
    } catch (e: any) {
      Logger.warn(`[HindiAPI] AniZip TMDB resolution failed: ${e?.message}`);
    }
  }

  try {
    let armUrl: string;
    if (params.malId) {
      armUrl = `https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${params.malId}`;
    } else if (params.anilistId) {
      armUrl = `https://arm.haglund.dev/api/v2/ids?source=anilist&id=${params.anilistId}`;
    } else {
      return null;
    }
    Logger.info(`[HindiAPI] Resolving TMDB via arm.haglund.dev: ${armUrl}`);
    const res = await fetch(armUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data.themoviedb) return String(data.themoviedb);
    return null;
  } catch (e: any) {
    Logger.warn(`[HindiAPI] TMDB resolution failed: ${e?.message}`);
    return null;
  }
}

export async function getEpisode(params: { tmdbId?: string; malId?: string; anilistId?: string; season: string; episode: string; type: string }): Promise<HindiApiResult> {
  const tmdbId = await resolveToTmdbId({ tmdbId: params.tmdbId, malId: params.malId, anilistId: params.anilistId });
  if (!tmdbId) throw new Error("Could not resolve TMDB ID from provided identifiers");

  const fileSlug = await getFileSlug(tmdbId, params.season, params.episode, params.type);
  const embedData = await getEmbedData(fileSlug);
  const streams = processEmbedData(embedData);

  const enriched = await Promise.all(
    streams.map(async (stream) => {
      try {
        const hls = await extractUniversal(stream.url);
        if (hls) return { ...stream, dhls: hls.streamUrl, headers: hls.headers };
      } catch (e: any) {
        Logger.warn(`[HindiAPI] HLS extraction failed for ${stream.provider}: ${e?.message}`);
      }
      return stream;
    })
  );

  return { meta: { tmdbId, season: params.season, episode: params.episode, slug: fileSlug }, streams: enriched };
}
