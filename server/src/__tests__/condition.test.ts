import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createConditionReader } from "../resources/condition.js";

const page = readFileSync(new URL("./fixtures/resources/pf-speech-swallowing-issues.head.html", import.meta.url), "utf8");

describe("condition overview", () => {
  it("serves the NIDCD reference and identified curated supplementary source without Bright Data", async () => {
    const { body } = await request(createApp({ conditionBrightData: null })).get("/api/condition").expect(200);
    expect(new URL(body.primary.url).hostname).toBe("www.nidcd.nih.gov");
    expect(body.related.provenance).toBe("curated");
    expect(body.related.retrievedAt).toBeNull();
  });
  it("deduplicates retrievals, recognizes cached metadata and keeps it after an upstream error", async () => {
    let now = Date.UTC(2026, 10, 15);
    const fetchPage = vi.fn(async (_url: string) => page);
    const read = createConditionReader({ fetchPage }, () => now);
    const [live, parallel] = await Promise.all([read(), read()]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toBe(live.related.url);
    expect(live).toEqual(parallel);
    expect(live.related.title).toBe("Speech & Swallowing Issues");
    expect(live.related.provenance).toBe("bright_data_live");
    expect((await read()).related.provenance).toBe("bright_data_cached");
    now += 86_400_001;
    fetchPage.mockRejectedValueOnce(new Error("Unavailable"));
    const stale = (await read()).related;
    expect(stale.provenance).toBe("bright_data_cached");
    expect(stale.retrievedAt).toBe(live.related.retrievedAt);
  });
  it("keeps verified source metadata when the local server restarts offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dysphagrip-source-"));
    try {
      const cache = join(dir, "condition.json");
      const live = await createConditionReader({ fetchPage: async () => page }, Date.now, cache)();
      const cached = await createConditionReader(null, Date.now, cache)();
      expect(cached.related.provenance).toBe("bright_data_cached");
      expect(cached.related.url).toBe(live.related.url);
      expect(cached.related.retrievedAt).toBe(live.related.retrievedAt);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("falls back when the source returns an unrelated page", async () => {
    const read = createConditionReader({ fetchPage: async () => page.replaceAll("Speech &amp; Swallowing Issues", "Home") });
    expect((await read()).related.provenance).toBe("curated");
  });
});
