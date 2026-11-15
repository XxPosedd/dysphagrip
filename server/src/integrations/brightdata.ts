/**
 * Bright Data Web Unlocker API, server-side only.
 * Docs: POST https://api.brightdata.com/request  (Authorization: Bearer <API key>)
 *       body: { zone, url, format: "raw" }  -> raw response body of the target page.
 *
 * Responsible use in this project:
 *  - Only hosts in BRIGHT_DATA_ALLOWED_HOSTS (vetted public-domain US-government pages) can be requested.
 *  - Pages that come back as bot challenges are skipped, never retried around.
 *  - Collection runs from a CLI script (npm run resources:refresh), never from a public HTTP endpoint.
 */
import { BRIGHT_DATA_ALLOWED_HOSTS } from "../resources/sources.js";

export class BrightDataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface BrightDataOptions {
  apiToken: string;
  zone: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowedHosts?: Set<string>;
}

export class BrightDataClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: BrightDataOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Fetch one page's raw HTML through the Web Unlocker zone. */
  async fetchPage(url: string): Promise<string> {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") throw new Error();
      host = u.hostname;
    } catch {
      throw new BrightDataError(`Invalid URL: ${url}`);
    }
    if (!(this.opts.allowedHosts ?? BRIGHT_DATA_ALLOWED_HOSTS).has(host)) {
      throw new BrightDataError(`Refusing to collect from non-vetted host: ${host}`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${(this.opts.baseUrl ?? "https://api.brightdata.com").replace(/\/$/, "")}/request`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: this.opts.zone, url, format: "raw" }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new BrightDataError((e as Error).name === "AbortError" ? "Bright Data request timed out" : "Could not reach Bright Data");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const brdError = res.headers.get("x-brd-error") ?? res.headers.get("x-luminati-error") ?? "";
      const body = (await res.text().catch(() => "")).slice(0, 200).replace(this.opts.apiToken, "[redacted]");
      const detail = [brdError, body].filter(Boolean).join(" ").trim();
      const hint =
        res.status === 401 || res.status === 403 ? "check BRIGHTDATA_API_TOKEN"
        : res.status === 400 || res.status === 404 ? "check BRIGHTDATA_ZONE (must be a Web Unlocker zone)"
        : res.status === 402 ? "Bright Data account has no remaining balance"
        : "";
      throw new BrightDataError(
        `Bright Data returned HTTP ${res.status}${hint ? ` (${hint})` : ""}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }
    return res.text();
  }
}

export function brightDataFromEnv(): BrightDataClient | null {
  const apiToken = process.env.BRIGHTDATA_API_TOKEN?.trim();
  const zone = process.env.BRIGHTDATA_ZONE?.trim();
  return apiToken && zone ? new BrightDataClient({ apiToken, zone }) : null;
}
