// @ts-ignore
import { connect } from "puppeteer-real-browser";
import { ensureBrowserRuntime } from "../../../lib/browser-runtime-bootstrap.js";

export interface ExtractResult {
  m3u8_url: string | null;
  encrypted: boolean;
  key_url: string | null;
  extraction_time_ms: number;
  error: string | null;
  audio_tracks?: any[];
  subtitles?: any[];
  thumbnail?: string;
}

export async function extractM3U8(embedUrl: string, referer?: string): Promise<ExtractResult> {
  const res: ExtractResult = {
    m3u8_url: null,
    encrypted: false,
    key_url: null,
    extraction_time_ms: 0,
    error: null,
  };

  let browser;
  try {
    const runtime = ensureBrowserRuntime();
    if (!runtime.chromePath) {
      throw new Error(
        "No Chrome/Chromium executable found. Set CHROME_PATH or enable auto install with CF_BYPASS_AUTO_INSTALL=true."
      );
    }

    const response: any = await connect({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      disableXvfb: !runtime.hasXvfb,
    });

    browser = response.browser;
    const page = response.page;

    if (referer) {
      await page.setExtraHTTPHeaders({
        'Referer': referer
      });
    }

    let foundM3u8 = false;

    const onResponse = async (response: any) => {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';

      if (contentType.includes('mpegURL') || url.includes('.m3u8') || contentType.includes('mpegurl')) {
        try {
          const text = await response.text();
          const hasMetadata = text.includes('#EXT-X-MEDIA') || text.includes('#EXT-X-STREAM-INF');
          const isMaster = url.includes('master') || url.includes('index') || hasMetadata;

          // If we already found a master/metadata-rich one, don't overwrite with a simpler one
          if (foundM3u8 && !isMaster) return;

          res.m3u8_url = url;
          if (isMaster) foundM3u8 = true; // Stop looking if it's a good one
          
          // Function to parse HLS attributes from a line
          const parseAttributes = (line: string) => {
            const attr: Record<string, string> = {};
            const matches = line.matchAll(/([A-Z-]+)=("[^"]*"|[^,]+)/g);
            for (const match of matches) {
               attr[match[1]] = match[2].replace(/^"|"$/g, '');
            }
            return attr;
          };

          const lines = text.split('\n');
          const audioTracks: any[] = [];
          const m3u8Subs: any[] = [];

          for (const line of lines) {
            if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
              const attr = parseAttributes(line);
              if (attr.NAME) {
                let uri = attr.URI;
                if (uri) {
                  try { uri = new URL(uri, url).toString(); } catch {}
                }
                audioTracks.push({ 
                  name: attr.NAME, 
                  language: attr.LANGUAGE || attr.NAME, 
                  url: uri, 
                  type: 'audio' 
                });
              }
            } else if (line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) {
              const attr = parseAttributes(line);
              if (attr.NAME && attr.URI) {
                let uri = attr.URI;
                try { uri = new URL(uri, url).toString(); } catch {}
                m3u8Subs.push({ 
                  label: attr.NAME, 
                  language: attr.LANGUAGE || attr.NAME, 
                  file: uri, 
                  kind: 'captions' 
                });
              }
            }
          }

          if (audioTracks.length > 0) res.audio_tracks = audioTracks;
          if (m3u8Subs.length > 0) {
            res.subtitles = (res.subtitles || []).concat(m3u8Subs);
          }

          if (text.includes('#EXT-X-KEY')) {
            const keyLine = lines.find((l: any) => l.includes('#EXT-X-KEY'));
            if (keyLine) {
               const attr = parseAttributes(keyLine);
               if (attr.URI) {
                 res.encrypted = true;
                 try { res.key_url = new URL(attr.URI, url).toString(); } catch { res.key_url = attr.URI; }
               }
            }
          }
        } catch { }
      } else if (url.includes('.vtt') || url.includes('.srt') || contentType.includes('text/vtt')) {
         // Captured external subtitle
         const nameMatch = url.match(/-([a-z]{3})(?:-|\.|$)/i) || url.match(/\/([^\/]+)\.vtt/i);
         const label = nameMatch ? nameMatch[1] : "External Sub";
         res.subtitles = res.subtitles || [];
         if (!res.subtitles.find(s => (s.file || s.url) === url)) {
           res.subtitles.push({ label, language: label, file: url, kind: 'captions' });
         }
      }
    };

    page.on('response', onResponse);

    try {
      await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      
      // Click play to trigger interaction (sometimes needed for subtitles/metadata)
      try {
        await page.click('body', { delay: 100 });
        await new Promise(r => setTimeout(r, 2000));
      } catch {}

      // Wait for jwplayer to be available
      await page.waitForFunction(() => (window as any).jwplayer !== undefined, { timeout: 10000 }).catch(() => {});

      // Aggressive subtitle and metadata scraping
      const scrapedData = await page.evaluate(() => {
        const results: any = { subs: [], image: null };
        
        // 1. Check specific known variables
        try {
          const vs = (window as any).videoSettings || (window as any).playerConfig || (window as any).config;
          if (vs && vs.tracks && Array.isArray(vs.tracks)) {
            results.subs = results.subs.concat(vs.tracks.filter((t: any) => t.kind === 'captions' || t.kind === 'subtitles'));
            if (vs.tracks.find((t: any) => t.kind === 'thumbnails')) {
               results.image = vs.tracks.find((t: any) => t.kind === 'thumbnails').file;
            }
          }
          if (vs && vs.image && !results.image) results.image = vs.image;
        } catch (e) {}

        // 2. Check all window properties for config-like objects

        // 2. Scrape script tags for JSON-like configurations
        try {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const content = s.textContent || "";
            if (content.includes('tracks') && content.includes('file')) {
              // Look for things that look like captions/tracks arrays
              const match = content.match(/["']?tracks["']?\s*:\s*(\[[^\]]+\])/);
              if (match) {
                try {
                  const cleaned = match[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"');
                  const tracks = JSON.parse(cleaned);
                  if (Array.isArray(tracks)) {
                    results.subs = results.subs.concat(tracks.filter((t: any) => t.kind === 'captions' || t.kind === 'subtitles'));
                  }
                } catch (e) {}
              }
            }
          }
        } catch (e) {}

        // 3. Scrape DOM for <track> elements
        try {
          const tracks = Array.from(document.querySelectorAll('track'));
          for (const t of tracks) {
            results.subs.push({
              label: t.label || t.srclang || "English",
              file: t.src,
              kind: t.kind || 'captions'
            });
          }
        } catch (e) {}

        // 4. Check for window.__INITIAL_STATE__ or other common patterns
        try {
           const commonStore = (window as any).__INITIAL_STATE__ || (window as any)._NEXT_DATA_?.props?.pageProps;
           if (commonStore && typeof commonStore === 'object') {
              const str = JSON.stringify(commonStore);
              if (str.includes('.vtt') || str.includes('.srt')) {
                 // Too complex to parse generically, but good to know it's there
                 console.log("Found VTT/SRT in store data");
              }
           }
        } catch(e) {}

        return results;
      });

      if (scrapedData) {
        if (scrapedData.subs && scrapedData.subs.length > 0) {
          res.subtitles = (res.subtitles || []).concat(scrapedData.subs);
        }
        if (scrapedData.image && !res.thumbnail) {
          res.thumbnail = scrapedData.image;
        }
      }

      // If we still have nothing, try the jwplayer getConfig (already improved but keep as fallback)
      const jwConfig = await page.evaluate(async () => {
        try {
          const jw = (window as any).jwplayer;
          if (typeof jw === 'function') {
            const players = [null, 0, "vplayer", "player", "player_container"];
            for (const p of players) {
              try {
                const player = p === null ? jw() : jw(p);
                if (player && typeof player.getConfig === 'function') {
                  const cfg = player.getConfig();
                  if (cfg) {
                    const pl = cfg.playlist && cfg.playlist[0] ? cfg.playlist[0] : {};
                    return {
                      tracks: pl.tracks || cfg.tracks || [],
                      captions: pl.captions || cfg.captions || [],
                      captionsList: cfg.captionsList || [],
                      image: pl.image || cfg.image,
                      sources: pl.sources || cfg.sources || [],
                      playlist: (typeof player.getPlaylist === 'function') ? player.getPlaylist() : []
                    };
                  }
                }
              } catch (e) {}
            }
          }
        } catch (e: any) {}
        return null;
      });

      if (jwConfig) {
        // Extract subtitles from jwConfig
        let subs: any[] = [];
        if (Array.isArray(jwConfig.tracks)) {
          subs = subs.concat(jwConfig.tracks).filter((t: any) => t.kind === 'captions' || t.kind === 'subtitles');
        }
        if (Array.isArray(jwConfig.captions)) {
          subs = subs.concat(jwConfig.captions);
        }
        if (Array.isArray(jwConfig.captionsList)) {
          subs = subs.concat(jwConfig.captionsList.filter((c: any) => c.id !== 'off'));
        }
        
        // Check playlist items
        if (Array.isArray(jwConfig.playlist)) {
           for (const item of jwConfig.playlist) {
              if (Array.isArray(item.tracks)) {
                 subs = subs.concat(item.tracks.filter((t: any) => t.kind === 'captions' || t.kind === 'subtitles'));
              }
           }
        }

        if (subs.length > 0) {
          res.subtitles = (res.subtitles || []).concat(subs);
        }
        
        if (jwConfig.image && !res.thumbnail) res.thumbnail = jwConfig.image;
      }

      // Deduplicate and clean up subtitles
      if (res.subtitles && Array.isArray(res.subtitles)) {
        const seen = new Set();
        res.subtitles = res.subtitles.filter(s => {
          const url = s.file || s.url || s.id;
          if (!url || seen.has(url)) return false;
          seen.add(url);
          return true;
        }).map(s => ({
          label: s.label || s.language || s.name || "Unknown",
          file: s.file || s.url || s.id,
          kind: s.kind || 'captions'
        }));
      }

      // Wait for M3U8 and metadata to be found (polling)
      if (!foundM3u8) {
        let retries = 0;
        while (!foundM3u8 && retries < 20) { // Max 10s wait
           await new Promise(r => setTimeout(r, 500));
           retries++;
        }
      }
    } catch (e: any) {
      if (!e.message.includes('Timeout') && !res.m3u8_url) res.error = e.message;
    }
  } catch (error: any) {
    if (!res.m3u8_url) res.error = error.message.toString();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return res;
}
