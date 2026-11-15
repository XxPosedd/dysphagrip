// Real Neon round-trip. Runs only when DATABASE_URL is set (after `npm run db:migrate --prefix server`):
//   npm run test:db --prefix server
// It creates one clearly-labelled test session and deletes it again.
import "../env.js";
import { describe, it, expect } from "vitest";
import { NeonSessionStore } from "../db.js";
import { parseSessionInput } from "../validation.js";
import { validPayload } from "./fixtures.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Neon integration", () => {
  it("round-trips a session with markers and quality summary", async () => {
    const store = new NeonSessionStore(url!);
    await store.ping();
    const input = parseSessionInput(validPayload({ label: "[automated test] Neon round-trip" }));
    const created = await store.create(input);
    try {
      expect(created.label).toBe("[automated test] Neon round-trip");
      expect(created.quality_ms).toEqual({ ok: 25_000, no_signal: 5_000, clipping: 0, mains_hum: 0 });
      const detail = await store.get(created.id);
      expect(detail?.markers.map((m) => m.kind)).toEqual(["audio_activity", "manual", "quality"]);
      expect(detail?.markers[1].note).toBe("sip of water");
      expect(detail?.markers[0].duration_ms).toBe(800);
      expect(detail?.median_noise_floor_dbfs).toBeCloseTo(-72.5, 1);
      const listed = await store.list(200);
      expect(listed.some((s) => s.id === created.id)).toBe(true);
    } finally {
      expect(await store.remove(created.id)).toBe(true);
    }
    expect(await store.get(created.id)).toBeNull();
  }, 30_000);
});
