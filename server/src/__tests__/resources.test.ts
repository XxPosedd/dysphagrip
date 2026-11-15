import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { BrightDataClient, BrightDataError } from "../integrations/brightdata.js";
import { collectResources } from "../resources/collect.js";
import { clean, looksLikeBotChallenge, parseMedlinePlusXml, parseNidcdPage, truncate } from "../resources/parse.js";
import { BRIGHT_DATA_ALLOWED_HOSTS, NIDCD_PAGES } from "../resources/sources.js";
import type { ResourceStore } from "../resources/store.js";
import type { PublicResource } from "../resources/types.js";

// Fixtures are real pages saved on 2026-11-14 (public-domain U.S. government content).
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "resources");
const fixture = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const PAGE_FIXTURE: Record<string, string> = {
  [NIDCD_PAGES[0]]: "nidcd-glossary-dysphagia.html",
  [NIDCD_PAGES[1]]: "nidcd-glossary-swallowing-disorders.html",
  [NIDCD_PAGES[2]]: "nidcd-1-in-12-children.html",
};
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>';

describe("NIDCD page parser (real pages)", () => {
  it("extracts title and official description", () => {
    const p = parseNidcdPage(fixture("nidcd-glossary-swallowing-disorders.html"));
    expect(p.title).toBe("Swallowing Disorders");
    expect(p.summary).toMatch(/^Swallowing Disorders: any of a group of problems/);
    expect(p.lastUpdated).toBeNull();
  });
  it("reads the Last Updated date when the page states one, and decodes entities", () => {
    const p = parseNidcdPage(fixture("nidcd-1-in-12-children.html"));
    expect(p.title).toMatch(/^Nearly 1 in 12 Children Ages 3–17/);
    expect(p.lastUpdated).toBe("2015-06-11T12:00:00.000Z");
    expect(p.summary).toContain("child's voice");
    expect(p.summary).not.toMatch(/back to infographic|&#039;/);
    expect(p.summary.length).toBeLessThanOrEqual(320);
  });
  it("refuses pages without a description instead of inventing one", () => {
    expect(() => parseNidcdPage(fixture("nidcd-voice-speech-language.html"))).toThrow(/no description/);
  });
  it("detects bot-challenge pages and skips them (never bypasses)", () => {
    expect(looksLikeBotChallenge(CLOUDFLARE)).toBe(true);
    for (const f of Object.values(PAGE_FIXTURE)) expect(looksLikeBotChallenge(fixture(f))).toBe(false);
    expect(() => parseNidcdPage(CLOUDFLARE)).toThrow(/bot-challenge/);
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
    expect(await client.fetchPage(NIDCD_PAGES[0])).toBe("<html>ok</html>");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brightdata.com/request");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ zone: "dysphagrip", url: NIDCD_PAGES[0], format: "raw" });
  });

  it("refuses non-vetted hosts and non-HTTPS URLs before calling Bright Data", async () => {
    const { client, fetchImpl } = make(() => new Response("x"));
    await expect(client.fetchPage("https://www.asha.org/public/")).rejects.toThrow(/non-vetted host/);
    await expect(client.fetchPage("http://www.nidcd.nih.gov/glossary/dysphagia")).rejects.toThrow(/Invalid URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps auth and zone errors with hints, never echoing the token", async () => {
    const auth = make(() => new Response(`bad token ${TOKEN}`, { status: 401, headers: { "x-brd-error": "Auth failed" } }));
    const e = await auth.client.fetchPage(NIDCD_PAGES[0]).catch((x) => x);
    expect(e).toBeInstanceOf(BrightDataError);
    expect(e.message).toMatch(/HTTP 401 \(check BRIGHTDATA_API_TOKEN\): Auth failed/);
    expect(e.message).not.toContain(TOKEN);
    const zone = make(() => new Response("zone not found", { status: 400 }));
    await expect(zone.client.fetchPage(NIDCD_PAGES[0])).rejects.toThrow(/BRIGHTDATA_ZONE/);
  });

  it("treats a 200 with x-brd-error (policy block) as a failure, not a page", async () => {
    // Exact shape observed live on 2026-11-14 for www.nidcd.nih.gov.
    const blocked = make(() => new Response("", { status: 200, headers: { "x-brd-error":
      "Access denied: www.nidcd.nih.gov is classified as Government and blocked by Bright Data as it might breach Bright Data usage policy." } }));
    const e = await blocked.client.fetchPage(NIDCD_PAGES[0]).catch((x) => x);
    expect(e).toBeInstanceOf(BrightDataError);
    expect(e.message).toMatch(/refused www\.nidcd\.nih\.gov \(Bright Data usage policy\): Access denied/);
    const empty = make(() => new Response("", { status: 200 }));
    await expect(empty.client.fetchPage(NIDCD_PAGES[0])).rejects.toThrow(/empty response/);
  });

  it("times out", async () => {
    const { client } = make((_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () =>
      rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), { timeoutMs: 20 });
    await expect(client.fetchPage(NIDCD_PAGES[0])).rejects.toThrow(/timed out/);
  });

  it("only vetted NIDCD pages are configured", () => {
    for (const p of NIDCD_PAGES) expect(BRIGHT_DATA_ALLOWED_HOSTS.has(new URL(p).hostname)).toBe(true);
  });
});

describe("collectResources", () => {
  const medlineFetch = (async (u: string | URL | Request) =>
    new Response(fixture(String(u).includes("Spanish") ? "medlineplus-es-disfagia.xml" : "medlineplus-swallowing.xml"))) as unknown as typeof fetch;
  const brightData = { fetchPage: vi.fn(async (url: string) => fixture(PAGE_FIXTURE[url])) };
  const now = () => new Date("2026-11-14T18:00:00.000Z");

  it("collects NIDCD via Bright Data and MedlinePlus via the official API, fully attributed", async () => {
    const r = await collectResources({ brightData, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.errors).toEqual([]);
    expect(r.resources).toHaveLength(5);
    const via = r.resources.map((x) => x.collected_via);
    expect(via.filter((v) => v === "bright_data_web_unlocker")).toHaveLength(3);
    expect(via.filter((v) => v === "medlineplus_api")).toHaveLength(2);
    for (const res of r.resources) {
      expect(res.source_url).toMatch(/^https:\/\/(www\.nidcd\.nih\.gov|medlineplus\.gov)\//);
      expect(res.publisher).toBeTruthy();
      expect(res.license_note).toMatch(/public domain/);
      expect(res.retrieved_at).toBe("2026-11-14T18:00:00.000Z");
      expect(res.summary.length).toBeGreaterThan(10);
    }
    expect(r.resources.find((x) => x.language === "es")?.publisher).toBe("MedlinePlus, Biblioteca Nacional de Medicina");
  });

  it("still collects MedlinePlus when Bright Data is not configured", async () => {
    const r = await collectResources({ brightData: null, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.skippedBrightData).toBe(true);
    expect(r.resources.map((x) => x.collected_via)).toEqual(["medlineplus_api", "medlineplus_api"]);
  });

  it("reports a failing source without aborting the others", async () => {
    const flaky = { fetchPage: async (url: string) => (url === NIDCD_PAGES[1] ? CLOUDFLARE : fixture(PAGE_FIXTURE[url])) };
    const r = await collectResources({ brightData: flaky, fetchImpl: medlineFetch, now, delayMs: 0 });
    expect(r.resources).toHaveLength(4);
    expect(r.errors).toEqual([{ source: NIDCD_PAGES[1], error: expect.stringMatching(/bot-challenge/) }]);
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
