export type CollectedVia = "bright_data_web_unlocker" | "medlineplus_api";

/** One attributed public-interest resource, as stored in Neon (public_resources) and shown in the dashboard. */
export interface PublicResource {
  source_url: string;
  title: string;
  summary: string;
  publisher: string;
  language: "en" | "es";
  collected_via: CollectedVia;
  license_note: string;
  /** Date the source itself says it was last updated, if it states one (ISO 8601). */
  source_last_updated: string | null;
  /** When DysphaGrip retrieved it (ISO 8601 UTC). */
  retrieved_at: string;
}
