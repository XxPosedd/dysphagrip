import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createResearchReader } from "../resources/research.js";

const dois = ["10.1109/EMBC53108.2024.10782007", "10.1016/j.cmpb.2017.03.009", "10.1016/j.compbiomed.2013.10.005"];
const response = (ids: string[]) => JSON.stringify({
  status: "ok", message: { items: ids.map((DOI) => ({
    DOI: DOI.toUpperCase(), title: ["A deposited title"], author: [{ given: "A.", family: "Researcher" }],
    "container-title": ["A scientific journal"], published: { "date-parts": [[2024, 7]] },
  })) },
});

describe("research citations", () => {
  it("returns linked primary studies when Bright Data has no credentials", async () => {
    const { body } = await request(createApp({ researchBrightData: null })).get("/api/research").expect(200);
    expect(body.brightData).toEqual({ configured: false, status: "unconfigured" });
    expect(body.studies).toHaveLength(3);
    for (const study of body.studies) {
      expect(study.provenance).toBe("curated");
      expect(study.retrievedAt).toBeNull();
      expect(study.url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${study.id}/`);
      expect(dois).toContain(study.doi);
    }
  });
  it("reads a fixed DOI list once, identifies cached responses and preserves metadata after an outage", async () => {
    const fetchPage = vi.fn(async (_url: string) => response(dois));
    let now = Date.UTC(2026, 10, 15);
    const read = createResearchReader({ fetchPage }, () => now);
    const [first, concurrent] = await Promise.all([read(), read()]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const target = new URL(fetchPage.mock.calls[0][0]);
    expect(target.origin).toBe("https://api.crossref.org");
    expect(target.searchParams.get("filter")).toBe(dois.map(doi => "doi:" + doi).join(","));
    expect(first).toEqual(concurrent);
    expect(first.brightData.status).toBe("live");
    expect(first.studies.every(s => s.provenance === "bright_data_live" && s.title === "A deposited title")).toBe(true);
    expect((await read()).brightData.status).toBe("cached");
    now += 86_400_001;
    fetchPage.mockRejectedValueOnce(new Error("upstream offline"));
    const stale = await read();
    expect(stale.studies[0].retrievedAt).toBe(first.studies[0].retrievedAt);
    expect(stale.studies.every(s => s.provenance === "bright_data_cached")).toBe(true);
  });
  it("distinguishes missing works and failures from live records", async () => {
    const partial = await createResearchReader({ fetchPage: async () => response([dois[1], "10.000/unknown"]) })();
    expect(partial.brightData.status).toBe("partial");
    expect(partial.studies.map(s => s.provenance)).toEqual(["curated", "bright_data_live", "curated"]);
    const invalid = await createResearchReader({ fetchPage: async () => "<html>Unavailable</html>" })();
    expect(invalid.brightData.status).toBe("unavailable");
    expect(invalid.studies).toHaveLength(3);
  });
});
