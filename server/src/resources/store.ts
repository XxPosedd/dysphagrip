import { neon } from "@neondatabase/serverless";
import type { PublicResource } from "./types.js";

export interface ResourceStore {
  /** Insert or update by source_url (re-collection refreshes text and retrieved_at). */
  upsert(resources: PublicResource[]): Promise<number>;
  list(): Promise<PublicResource[]>;
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export class NeonResourceStore implements ResourceStore {
  private sql: ReturnType<typeof neon>;
  constructor(url: string) {
    this.sql = neon(url);
  }

  async upsert(rs: PublicResource[]): Promise<number> {
    if (!rs.length) return 0;
    const col = <K extends keyof PublicResource>(k: K) => rs.map((r) => r[k]);
    const rows = await this.sql`
      INSERT INTO public_resources
        (source_url, title, summary, publisher, language, collected_via, license_note, source_last_updated, retrieved_at)
      SELECT * FROM unnest(
        ${col("source_url")}::text[], ${col("title")}::text[], ${col("summary")}::text[], ${col("publisher")}::text[],
        ${col("language")}::text[], ${col("collected_via")}::text[], ${col("license_note")}::text[],
        ${col("source_last_updated")}::timestamptz[], ${col("retrieved_at")}::timestamptz[])
      ON CONFLICT (source_url) DO UPDATE SET
        title = EXCLUDED.title, summary = EXCLUDED.summary, publisher = EXCLUDED.publisher,
        language = EXCLUDED.language, collected_via = EXCLUDED.collected_via, license_note = EXCLUDED.license_note,
        source_last_updated = EXCLUDED.source_last_updated, retrieved_at = EXCLUDED.retrieved_at
      RETURNING source_url`;
    return (rows as unknown[]).length;
  }

  async list(): Promise<PublicResource[]> {
    const rows = (await this.sql`
      SELECT source_url, title, summary, publisher, language, collected_via, license_note, source_last_updated, retrieved_at
      FROM public_resources
      WHERE summary IS NOT NULL
      ORDER BY language, CASE collected_via WHEN 'medlineplus_api' THEN 0 ELSE 1 END, title`) as Record<string, unknown>[];
    return rows.map((r) => ({
      source_url: String(r.source_url),
      title: String(r.title),
      summary: String(r.summary),
      publisher: String(r.publisher),
      language: r.language === "es" ? "es" : "en",
      collected_via: r.collected_via === "medlineplus_api" ? "medlineplus_api" : "bright_data_web_unlocker",
      license_note: String(r.license_note),
      source_last_updated: iso(r.source_last_updated),
      retrieved_at: iso(r.retrieved_at)!,
    }));
  }
}

export function resourceStoreFromEnv(): ResourceStore | null {
  return process.env.DATABASE_URL ? new NeonResourceStore(process.env.DATABASE_URL) : null;
}
