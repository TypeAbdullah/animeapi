import { getCloudflareClearance, getCfPageInstance } from "../../../lib/cf-bypass.js";
import { Logger } from "../../../utils/logger.js";

let domainCleared = false;

/**
 * Fetches HTML content from a URL by reusing the CF-authenticated browser session.
 * On the first call, navigates to the domain to obtain cf_clearance.
 * Subsequent calls use in-page fetch() to avoid re-triggering CF challenges.
 */
export async function browserFetch(url: string, referer?: string): Promise<string> {
  // First call: establish CF clearance on the domain
  if (!domainCleared) {
    const origin = new URL(url).origin;
    const clearance = await getCloudflareClearance(origin + "/home");
    if (!clearance || !clearance.success) {
      throw new Error(`[browserFetch] Failed to bypass CF for ${origin}`);
    }
    domainCleared = true;
    // If the requested URL is the home page, return the HTML directly
    if (url === origin + "/home" || url === origin + "/") {
      return clearance.html || "";
    }
  }

  // Use the authenticated page context to fetch HTML (like browserAjax but for HTML)
  const page = getCfPageInstance();
  if (!page) throw new Error("[browserFetch] Puppeteer page context not ready.");

  try {
    const html = await page.evaluate(async (fetchUrl: string, ref: string | undefined) => {
      const headers: Record<string, string> = {
        "Accept": "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      };
      if (ref) headers["Referer"] = ref;

      const res = await fetch(fetchUrl, { headers });
      return await res.text();
    }, url, referer);

    return html;
  } catch (err: any) {
    Logger.error(`[browserFetch] In-page fetch failed for ${url}: ${err.message}`);
    throw err;
  }
}

/**
 * Executes a fetch request inside the Puppeteer browser context to bypass CF for AJAX calls.
 */
export async function browserAjax(url: string, options: any = {}): Promise<any> {
  // Ensure domain is cleared first
  if (!domainCleared) {
    await browserFetch(url, options?.headers?.Referer);
  }

  const page = getCfPageInstance();
  if (!page) throw new Error("[browserAjax] Puppeteer page context not ready. Call browserFetch first.");

  const result = await page.evaluate(async (fetchUrl: string, fetchOpts: any) => {
    const res = await fetch(fetchUrl, fetchOpts);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return await res.text();
  }, url, options);

  return result;
}
