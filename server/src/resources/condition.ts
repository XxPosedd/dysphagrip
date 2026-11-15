import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrightDataClient } from "../integrations/brightdata.js";
import { parseHtmlPage } from "./parse.js";
import { BRIGHT_DATA_SOURCES } from "./sources.js";

const primary = {
  title: "Dysphagia fact sheet (PDF)",
  publisher: "National Institute on Deafness and Other Communication Disorders",
  url: "https://www.nidcd.nih.gov/sites/default/files/Documents/health/voice/NIDCD-Dysphagia.pdf",
};
const related = BRIGHT_DATA_SOURCES.find(source => source.url.endsWith("/non-movement-symptoms/speech-swallowing"))!;

const overview = {
  description: "Dysphagia means difficulty swallowing. Swallowing may hurt, or food, drinks or even saliva may be hard to swallow. This can make it difficult to get enough fluids and nutrition.",
  research: "Researchers study sounds and vibrations at the neck to understand which patterns accompany a swallow and which also occur during speech, coughing or head movement.",
  scope: "DysphaGrip estimates these activities from two external sensors. Its recordings cannot diagnose dysphagia, detect aspiration or tell whether a swallow was safe.",
  primary,
};

type ConditionSource = {
  title: string; publisher: string; url: string;
  provenance: "curated" | "bright_data_live" | "bright_data_cached"; retrievedAt: string | null;
};
const fallback: ConditionSource = {
  title: "Speech & Swallowing Issues", publisher: related.publisher, url: related.url,
  provenance: "curated", retrievedAt: null,
};

export function createConditionReader(client: Pick<BrightDataClient, "fetchPage"> | null, now = Date.now, cacheFile?: string) {
  let saved: ConditionSource | undefined;
  let refreshAt = 0;
  if (cacheFile) {
    try {
      const entry = JSON.parse(readFileSync(cacheFile, "utf8"));
      const timestamp = Date.parse(entry.retrievedAt);
      if (entry.url === related.url && typeof entry.title === "string" && /^speech (?:&|and) swallowing issues$/i.test(entry.title)
          && Number.isFinite(timestamp) && timestamp <= now()) {
        saved = { ...fallback, title: entry.title, retrievedAt: new Date(timestamp).toISOString(), provenance: "bright_data_cached" };
        refreshAt = timestamp + 86_400_000;
      }
    } catch { /* An empty cache is normal on the first run. */ }
  }
  let pending: Promise<ConditionSource> | undefined;
  const current = (): ConditionSource => saved ? { ...saved, provenance: "bright_data_cached" } : fallback;

  async function refresh(): Promise<ConditionSource> {
    try {
      const html = await client!.fetchPage(related.url);
      const page = parseHtmlPage(html, { titleSuffix: related.titleSuffix });
      // A generic landing page or a redirect must not be attributed to this resource.
      if (!/^speech (?:&|and) swallowing issues$/i.test(page.title)) throw new Error("Unexpected source title");
      saved = { ...fallback, title: page.title, provenance: "bright_data_live", retrievedAt: new Date(now()).toISOString() };
      if (cacheFile) {
        try {
          mkdirSync(dirname(cacheFile), { recursive: true });
          const temp = cacheFile + "." + process.pid + ".tmp";
          writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
          renameSync(temp, cacheFile);
        } catch { /* The in-memory cache remains available on a read-only system. */ }
      }
      refreshAt = now() + 86_400_000;
      return saved;
    } catch {
      refreshAt = now() + 600_000;
      return current();
    }
  }

  return async () => {
    if (!client || now() < refreshAt) return { ...overview, related: current() };
    pending ??= refresh().finally(() => { pending = undefined; });
    return { ...overview, related: await pending };
  };
}
