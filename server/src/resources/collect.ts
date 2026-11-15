import type { BrightDataClient } from "../integrations/brightdata.js";
import { parseHtmlPage, parseMedlinePlusXml } from "./parse.js";
import {
  BRIGHT_DATA_SOURCES, FETCH_DELAY_MS, MEDLINEPLUS_LICENSE, MEDLINEPLUS_QUERIES, SWALLOWING_TOPIC,
} from "./sources.js";
import type { PublicResource } from "./types.js";

export interface CollectDeps {
  brightData: Pick<BrightDataClient, "fetchPage"> | null;
  /** Fetches the MedlinePlus web service (official API; no Bright Data needed). */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  delayMs?: number;
  log?: (msg: string) => void;
}

export interface CollectReport {
  resources: PublicResource[];
  errors: Array<{ source: string; error: string }>;
  skippedBrightData: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchMedlinePlus(db: string, term: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `https://wsearch.nlm.nih.gov/ws/query?db=${encodeURIComponent(db)}&term=${encodeURIComponent(term)}&rettype=brief&retmax=5`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "DysphaGrip/0.1 (hackathon research prototype)" } });
  if (!res.ok) throw new Error(`MedlinePlus web service returned HTTP ${res.status}`);
  return res.text();
}

/** Collect every vetted source. Failures are reported per source; one failing source never aborts the rest. */
export async function collectResources(deps: CollectDeps): Promise<CollectReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const delay = deps.delayMs ?? FETCH_DELAY_MS;
  const resources: PublicResource[] = [];
  const errors: CollectReport["errors"] = [];

  // 1) Non-profit pages via Bright Data Web Unlocker (no official API exists for these pages).
  if (!deps.brightData) {
    log("Bright Data not configured (BRIGHTDATA_API_TOKEN / BRIGHTDATA_ZONE): skipping Bright Data sources.");
  } else {
    for (const [i, src] of BRIGHT_DATA_SOURCES.entries()) {
      if (i > 0 && delay > 0) await sleep(delay);
      try {
        const page = parseHtmlPage(await deps.brightData.fetchPage(src.url), { titleSuffix: src.titleSuffix });
        resources.push({
          source_url: src.url, title: page.title, summary: page.summary, publisher: src.publisher,
          language: "en", collected_via: "bright_data_web_unlocker", license_note: src.licenseNote,
          source_last_updated: page.lastUpdated, retrieved_at: now().toISOString(),
        });
        log(`✓ ${src.url}`);
      } catch (e) {
        errors.push({ source: src.url, error: (e as Error).message });
        log(`✗ ${src.url}: ${(e as Error).message}`);
      }
    }
  }

  // 2) MedlinePlus via its official web service.
  for (const q of MEDLINEPLUS_QUERIES) {
    const label = `MedlinePlus ${q.db} ${q.term}`;
    try {
      const topics = parseMedlinePlusXml(await fetchMedlinePlus(q.db, q.term, deps.fetchImpl));
      const topic = topics.find((t) => SWALLOWING_TOPIC.test([t.title, ...t.altTitles].join(" ")));
      if (!topic) throw new Error("No swallowing-related topic in results");
      if (!/^https:\/\/medlineplus\.gov\//.test(topic.url)) throw new Error(`Unexpected URL ${topic.url}`);
      resources.push({
        source_url: topic.url, title: topic.title, summary: topic.summary,
        publisher: `MedlinePlus, ${topic.organization || "National Library of Medicine"}`,
        language: q.language, collected_via: "medlineplus_api", license_note: MEDLINEPLUS_LICENSE,
        source_last_updated: null, retrieved_at: now().toISOString(),
      });
      log(`✓ ${label} -> ${topic.url}`);
    } catch (e) {
      errors.push({ source: label, error: (e as Error).message });
      log(`✗ ${label}: ${(e as Error).message}`);
    }
  }

  return { resources, errors, skippedBrightData: !deps.brightData };
}
