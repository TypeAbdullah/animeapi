import { extractM3U8 } from "./extractM3U8.js";
import { Logger } from "../../../utils/logger.js";

let extractionLock = Promise.resolve();

export async function processAllSources(sources: any[]) {
  if (!sources || !Array.isArray(sources)) return sources;

  const results = [];
  for (const src of sources) {
    // If it already has an m3u8 or it's not an embed/link, skip browser extraction
    if (src.isM3U8 || src.m3u8_url || !src.url || src.url.includes('.m3u8')) {
        if (src.url?.includes('.m3u8')) src.isM3U8 = true;
        results.push(src);
        continue;
    }

    // Wrap extraction in the global lock to prevent concurrency issues
    const processedSrc = await (extractionLock = extractionLock.then(async () => {
      try {
        // Host-specific Referer logic
        let referer: string | undefined = undefined;
        if (src.url.includes('as-cdn21.top') || src.url.includes('toonstream')) {
          referer = 'https://animelok.xyz/';
        }

        const ext = await extractM3U8(src.url, referer);
        const logMsg = `[Extraction] Result for ${src.name || src.url}: m3u8=${!!ext.m3u8_url}, audio=${ext.audio_tracks?.length || 0}, subs=${ext.subtitles?.length || 0}, error=${ext.error}`;
        Logger.info(logMsg);
        
        if (ext.m3u8_url) {
          src.m3u8_url = ext.m3u8_url;
          src.isM3U8 = true;
          src.m3u8_extracted = true;
          
          // Add multi-language data if available
          if (ext.audio_tracks) src.audio_tracks = ext.audio_tracks;
          if (ext.subtitles) {
            src.subtitles = ext.subtitles.map((s: any) => ({
              ...s,
              lang: s.lang || s.label || s.language || "Unknown",
              url: s.url || s.file || s.id
            }));
          }
          if (ext.thumbnail) src.thumbnail = ext.thumbnail;
          
          if (ext.encrypted) {
            src.encrypted = true;
            src.encrypt = true;
            src.key_url = ext.key_url;
          }
        }
      } catch (err: any) {
        Logger.error(`[Extraction] Error for ${src.url}: ${err.message}`);
      }
      return src;
    }));
    results.push(processedSrc);
  }
  return results;
}
