import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { BrightDataClient, BrightDataError } from "../integrations/brightdata.js";
import { collectResources } from "../resources/collect.js";
import { clean, looksLikeBotChallenge, parseHtmlPage, parseMedlinePlusXml, truncate } from "../resources/parse.js";
import { BRIGHT_DATA_ALLOWED_HOSTS, BRIGHT_DATA_SOURCES } from "../resources/sources.js";
import type { ResourceStore } from "../resources/store.js";
import type { PublicResource } from "../resources/types.js";

// Fixtures saved 2026-11-14. Non-profit pages: <title>/<meta> only (bodies are copyrighted and omitted).
// MedlinePlus XML and the NIDCD page are public-domain U.S. government content.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "resources");
const fixture = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const [PF_ISSUES, PF_FACTS, SPOHNC] = BRIGHT_DATA_SOURCES;
const PAGE_FIXTURE: Record<string, string> = {
  [PF_ISSUES.url]: "pf-speech-swallowing-issues.head.html",
  [PF_FACTS.url]: "pf-speech-swallowing-fact-sheet.head.html",
  [SPOHNC.url]: "spohnc-swallowing-assessment.head.html",
};
const NIDCD_URL = "https://www.nidcd.nih.gov/glossary/dysphagia";
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>';

describe("HTML page parser (real pages)", () => {
  it("extracts title (minus site suffix) and the publisher's own description", () => {
    const p = parseHtmlPage(fixture(PAGE_FIXTURE[PF_ISSUES.url]), { titleSuffix: PF_ISSUES.titleSuffix });
    expect(p.title).toBe("Speech & Swallowing Issues");
    expect(p.summary).toBe("Learn how PD can affect the muscles in the face, mouth and throat that can lead to speech & communication/voice issues.");
    const f = parseHtmlPage(fixture(PAGE_FIXTURE[PF_FACTS.url]), { titleSuffix: PF_FACTS.titleSuffix });
    expect(f.title).toBe("Speech & Swallowing in Parkinson’s");
    expect(f.summary).toMatch(/^Speech and swallowing challenges are common/);
  });
  it("marks a description the site itself cut mid-sentence with an ellipsis, and reads article:modified_time", () => {
    const p = parseHtmlPage(fixture(PAGE_FIXTURE[SPOHNC.url]), { titleSuffix: SPOHNC.titleSuffix });
    expect(p.title).toBe("Swallowing Assessment for Head and Neck Cancer Survivors: Expectations and Outcomes");
    expect(p.summary).toMatch(/impaired swallowing is one of…$/);
    expect(p.lastUpdated).toBe("2026-06-16T20:18:43.000Z");
  });
  it("reads the NIDCD-style 'Last Updated Date' <time> and decodes entities", () => {
    const p = parseHtmlPage(fixture("nidcd-1-in-12-children.html"), { titleSuffix: /\s*\|\s*NIDCD\s*$/i });
    expect(p.title).toMatch(/^Nearly 1 in 12 Children Ages 3–17/);
    expect(p.lastUpdated).toBe("2015-06-11T12:00:00.000Z");
    expect(p.summary).toContain("child's voice");
    expect(p.summary).not.toMatch(/back to infographic|&#039;/);
  });
  it("refuses pages without a description instead of inventing one", () => {
    expect(() => parseHtmlPage("<html><head><title>Hub page</title></head><body><p>Lots of text</p></body></html>"))
      .toThrow(/no description/);
  });
  it("ignores markup inside HTML comments", () => {
    const html = '<html><head><!-- <title>Wrong</title> <meta name="description" content="wrong"> --><title>Right | Site</title>' +
      '<meta name="description" content="The real description."></head></html>';
    expect(parseHtmlPage(html, { titleSuffix: /\s*\|\s*Site$/ })).toMatchObject({ title: "Right", summary: "The real description." });
  });
  it("detects bot-challenge pages and skips them (never bypasses)", () => {
    expect(looksLikeBotChallenge(CLOUDFLARE)).toBe(true);
    for (const f of Object.values(PAGE_FIXTURE)) expect(looksLikeBotChallenge(fixture(f))).toBe(false);
    expect(() => parseHtmlPage(CLOUDFLARE)).toThrow(/bot-challenge/);
  });
});

describe("MedlinePlus web-service parser (real responses)", () => {
  it("parses English and Spanish topics", () => {
    const [en] = parseMedlinePlusXml(fixture("medlineplus-swallowing.xml"));
    expect(en).toMatchObject({ url: "https://medlineplus.gov/swallowingdisorders.html", title: "Swallowing Disorders",
      organization: "National Library of Medicine", altTitles: ["Dysphagia"] });
    expect(en.summary).toMatch(/^If you have a swallowing disorder, you may have difficulty/);
    const [es] = parseMedlinePlusXml(fixture("medlineplus-es-disfagia.xml"));
    expect(es.title).toBe("Problemas para tragar");
    expect(es.altTitles).toContain("Disfagia");
  });
  it("rejects non-MedlinePlus payloads", () => {
    expect(() => parseMedlinePlusXml("<html></html>")).toThrow();
  });
});

describe("text helpers", () => {
  it("cleans tags, entities and stray spaces before punctuation", () => {
    expect(clean('<p>A <span class="x">swallowing disorder</span> , ok &amp; &#039;fine&#039;</p>')).toBe("A swallowing disorder, ok & 'fine'");
  });
  it("truncates at sentence or word boundaries", () => {
    expect(truncate("Short.")).toBe("Short.");
    const long = "First sentence is here. " + "word ".repeat(100);
    expect(truncate(long, 40)).toBe("First sentence is here."); // sentence end past the halfway mark -> cut there
    expect(truncate(long, 60)).toMatch(/^First sentence is here\. (word )+word…$/); // otherwise cut at a word
    expect(truncate("word ".repeat(100), 30).endsWith("…")).toBe(true);
  });
});

describe("BrightDataClient", () => {
  const TOKEN = "brd_test_token_SECRET_123";
  const make = (responder: (url: string, init: RequestInit) => Response | Promise<Response>, extra = {}) => {
    const fetchImpl = vi.fn(async (u: string | URL | Request, i?: RequestInit) => responder(String(u), i ?? {}));
    return { client: new BrightDataClient({ apiToken: TOKEN, zone: "dysphagrip", fetchImpl: fetchImpl as unknown as typeof fetch, ...extra }), fetchImpl };
  };

  it("sends the documented Web Unlocker request", async () => {
    const { client, fetchImpl } = make(() => new Response("<html>ok</html>"));
    expect(await client.fetchPage(PF_ISSUES.url)).toBe("<html>ok</html>");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brightdata.com/request");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ zone: "dysphagrip", url: PF_ISSUES.url, format: "raw" });
  });

  it("refuses non-vetted hosts and non-HTTPS URLs before calling Bright Data", async () => {
    const { client, fetchImpl } = make(() => new Response("x"));
    await expect(client.fetchPage("https://www.asha.org/public/")).rejects.toThrow(/non-vetted host/);
    await expect(client.fetchPage(NIDCD_URL)).rejects.toThrow(/non-vetted host/); // Bright Data blocks .gov anyway
    await expect(client.fetchPage("http://www.parkinson.org/understanding-parkinsons/non-movement-symptoms/speech-swallowing")).rejects.toThrow(/Invalid URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps auth and zone errors with hints, never echoing the token", async () => {
    const auth = make(() => new Response(`bad token ${TOKEN}`, { status: 401, headers: { "x-brd-error": "Auth failed" } }));
    const e = await auth.client.fetchPage(PF_ISSUES.url).catch((x) => x);
    expect(e).toBeInstanceOf(BrightDataError);
    expect(e.message).toMatch(/HTTP 401 \(check BRIGHTDATA_API_TOKEN\): Auth failed/);
    expect(e.message).not.toContain(TOKEN);
    const zone = make(() => new Response("zone not found", { status: 400 }));
    await expect(zone.client.fetchPage(PF_ISSUES.url)).rejects.toThrow(/BRIGHTDATA_ZONE/);
  });

  it("treats a 200 with x-brd-error (policy block) as a failure, not a page", async () => {
    // Exact shape observed live on 2026-11-14 for www.nidcd.nih.gov.
    const blocked = make(() => new Response("", { status: 200, headers: { "x-brd-error":
      "Access denied: www.nidcd.nih.gov is classified as Government and blocked by Bright Data as it might breach Bright Data usage policy." } }));
    const e = await blocked.client.fetchPage(PF_ISSUES.url).catch((x) => x);
    expect(e).toBeInstanceOf(BrightDataError);
    expect(e.message).toMatch(/refused www\.parkinson\.org \(Bright Data usage policy\): Access denied/);
    const empty = make(() => new Response("", { status: 200 }));
    await expect(empty.client.fetchPage(PF_ISSUES.url)).rejects.toThrow(/empty response/);
  });

  it("times out", async () => {
    const { client } = make((_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () =>
      rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), { timeoutMs: 20 });
    await expect(client.fetchPage(PF_ISSUES.url)).rejects.toThrow(/timed out/);
  });

  it("allows exactly the vetted non-profit hosts", () => {
    expect([...BRIGHT_DATA_ALLOWED_HOSTS].sort()).toEqual(["www.parkinson.org", "www.spohnc.org"]);
  });
});

describe("collectResources", () => {
  const medlineFetch = (async (u: string | URL | Request) =>
    new Response(fixture(String(u).includes("Spanish") ? "medlineplus-es-disfagia.xml" : "medlineplus-swallowing.xml"))) as unknown as typeof fetch;
  const brightData = { fetchPage: vi.fn(async (url: string) => fixture(PAGE_FIXTURE[url])) };
  const now = () => new Date("2026-11-14T18:00:00.000Z");

  it("collects non-profit pages via Bright Data and MedlinePlus via the official API, fully attributed", async () => {
    const r = await collectResources({ brightData, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.errors).toEqual([]);
    expect(r.resources).toHaveLength(5);
    const via = r.resources.map((x) => x.collected_via);
    expect(via.filter((v) => v === "bright_data_web_unlocker")).toHaveLength(3);
    expect(via.filter((v) => v === "medlineplus_api")).toHaveLength(2);
    for (const res of r.resources) {
      expect(res.source_url).toMatch(/^https:\/\/(www\.parkinson\.org|www\.spohnc\.org|medlineplus\.gov)\//);
      expect(res.publisher).toBeTruthy();
      expect(res.license_note).toMatch(res.collected_via === "medlineplus_api" ? /public domain/ : /^© .*link to the original page/);
      expect(res.retrieved_at).toBe("2026-11-14T18:00:00.000Z");
      expect(res.summary.length).toBeGreaterThan(10);
    }
    expect(r.resources.find((x) => x.language === "es")?.publisher).toBe("MedlinePlus, Biblioteca Nacional de Medicina");
    expect(r.resources.filter((x) => x.publisher === "Parkinson's Foundation")).toHaveLength(2);
  });

  it("still collects MedlinePlus when Bright Data is not configured", async () => {
    const r = await collectResources({ brightData: null, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.skippedBrightData).toBe(true);
    expect(r.resources.map((x) => x.collected_via)).toEqual(["medlineplus_api", "medlineplus_api"]);
  });

  it("reports a failing source without aborting the others", async () => {
    const flaky = { fetchPage: async (url: string) => (url === PF_FACTS.url ? CLOUDFLARE : fixture(PAGE_FIXTURE[url])) };
    const r = await collectResources({ brightData: flaky, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.resources).toHaveLength(4);
    expect(r.errors).toEqual([{ source: PF_FACTS.url, error: expect.stringMatching(/bot-challenge/) }]);
  });

  it("rejects MedlinePlus results that are not about swallowing", async () => {
    const offTopic = (async () => new Response(fixture("medlineplus-swallowing.xml")
      .replace(/Swallowing Disorders|Dysphagia|swallowing/gi, "Knee Pain"))) as unknown as typeof fetch;
    const r = await collectResources({ brightData: null, fetchImpl: offTopic, now, delayMs: 0 });
    expect(r.resources).toHaveLength(0);
    expect(r.errors[0].error).toMatch(/No swallowing-related topic/);
  });
});

describe("GET /api/resources", () => {
  const sample: PublicResource = {
    source_url: "https://medlineplus.gov/swallowingdisorders.html", title: "Swallowing Disorders", summary: "If you have…",
    publisher: "MedlinePlus, National Library of Medicine", language: "en", collected_via: "medlineplus_api",
    license_note: "public domain", source_last_updated: null, retrieved_at: "2026-11-14T18:00:00.000Z",
  };
  const store = (list: () => Promise<PublicResource[]>): ResourceStore => ({ upsert: async () => 0, list });

  it("lists stored resources", async () => {
    const res = await request(createApp({ store: null, resources: store(async () => [sample]) })).get("/api/resources");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, resources: [sample] });
  });
  it("explains how to collect when empty, and never fabricates entries", async () => {
    const res = await request(createApp({ store: null, resources: store(async () => []) })).get("/api/resources");
    expect(res.body.resources).toEqual([]);
    expect(res.body.note).toMatch(/resources:refresh/);
    const none = await request(createApp({ store: null, resources: null })).get("/api/resources");
    expect(none.body).toMatchObject({ configured: false, resources: [] });
  });
  it("returns 502 on database errors", async () => {
    const res = await request(createApp({ store: null, resources: store(async () => { throw new Error("db down"); }) })).get("/api/resources");
    expect(res.status).toBe(502);
  });
  it("has no public endpoint that triggers collection", async () => {
    const res = await request(createApp({ store: null, resources: null })).post("/api/resources/refresh");
    expect(res.status).toBe(404);
  });
});
