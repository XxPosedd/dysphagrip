import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { PublicResource } from "../lib/types";
import { Card, Chip } from "./Panels";

const VIA: Record<PublicResource["collected_via"], string> = {
  bright_data_web_unlocker: "Retrieved via Bright Data",
  medlineplus_api: "Retrieved via MedlinePlus official API",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Attributed public-interest resources (US). Every card shows source, publisher, collection method and dates. */
export function ResourcesPanel({ brightDataConfigured }: { brightDataConfigured: boolean }) {
  const [items, setItems] = useState<PublicResource[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"all" | "en" | "es">("all");

  const load = useCallback(async () => {
    try {
      const r = await api.resources();
      setItems(r.resources);
      setNote(r.note ?? null);
      setError(null);
    } catch (e) {
      setItems([]);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = (items ?? []).filter((r) => lang === "all" || r.language === lang);
  const viaBrightData = (items ?? []).filter((r) => r.collected_via === "bright_data_web_unlocker").length;
  const hasSpanish = (items ?? []).some((r) => r.language === "es");

  return (
    <Card title="Swallowing support resources (US)" aside={
      <div className="row">
        <Chip tone={brightDataConfigured ? "good" : "neutral"}>{brightDataConfigured ? "Bright Data" : "Bright Data not configured"}</Chip>
        {hasSpanish && (
          <div className="seg" role="group" aria-label="Language">
            {(["all", "en", "es"] as const).map((l) => (
              <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
                {l === "all" ? "All" : l === "en" ? "English" : "Español"}
              </button>
            ))}
          </div>
        )}
      </div>
    }>
      <p className="muted small">Public information from U.S. health organisations: MedlinePlus (National Library of Medicine) and
        non-profit patient organisations. These are links to the original publishers, not advice from DysphaGrip. A
        speech-language pathologist or physician can assess swallowing.</p>
      {error && <p className="error">{error}</p>}
      {items === null ? <p className="muted small">Loading…</p> : shown.length === 0 ? (
        <p className="empty">{note ?? "No resources collected yet."}</p>
      ) : (
        <ul className="resources">
          {shown.map((r) => (
            <li key={r.source_url} className="resource" lang={r.language}>
              <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="resource-title">{r.title} ↗</a>
              <p>{r.summary}</p>
              <div className="resource-meta small">
                <span>{r.publisher}</span>
                <span className={`via via-${r.collected_via}`}>{VIA[r.collected_via]}</span>
                <span>Retrieved {day(r.retrieved_at)}</span>
                {r.source_last_updated && <span>Source updated {day(r.source_last_updated)}</span>}
                <span title={r.license_note}>{/public domain/i.test(r.license_note) ? "Public domain" : `© ${r.publisher.split(":")[0]} · linked`}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items !== null && !error && (
        <p className="muted small">
          {items.length} source{items.length === 1 ? "" : "s"} · {viaBrightData} collected through Bright Data's Web Unlocker API from
          vetted public pages (terms and robots rules checked; no bot challenges bypassed; only titles and the publisher's own
          descriptions are stored) · refresh with{" "}
          <code>npm run resources:refresh</code>
        </p>
      )}
    </Card>
  );
}
