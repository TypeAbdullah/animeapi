export function substringBefore(str: string, pattern: string): string {
  const idx = str.indexOf(pattern);
  return idx === -1 ? str : str.substring(0, idx);
}

export function substringAfter(str: string, pattern: string): string {
  const idx = str.indexOf(pattern);
  return idx === -1 ? str : str.substring(idx + pattern.length);
}

export function substringAfterLast(str: string, pattern: string): string {
  return str.split(pattern).pop() ?? "";
}

// try to parse JSON and grab the requested key; if it blows up, just give back an empty string
export function getMapValue(mapString: string, key: string): string {
  try {
    const map = JSON.parse(mapString);
    return map[key] != null ? String(map[key]) : "";
  } catch {
    return "";
  }
}

// headers that pretend we're not robots and trick DDoS‑Guard into letting us through
export const DDOS_GUARD_HEADERS = {
  Cookie: "__ddg1_=;__ddg2_=;",
} as const;

/** Default User-Agent for requests that enforce UA checks. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
