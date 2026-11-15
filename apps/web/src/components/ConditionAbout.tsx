import { useEffect, useState } from "react";
import { request } from "../lib/api";
import { API_BASE } from "../lib/config";

type Source = { title: string; url: string; publisher: string };
type Condition = {
  description: string; research: string; scope: string; primary: Source;
  related: Source & { provenance: "bright_data_live" | "bright_data_cached" | "curated"; retrievedAt: string | null };
};

export function ConditionAbout({ revision }: { revision: number }) {
  const [data, setData] = useState<Condition | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<Condition>(API_BASE + "/api/condition", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setData(result); setError(false); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);
  const provenance = { curated: "Curated reference", bright_data_live: "Retrieved via Bright Data", bright_data_cached: "Cached via Bright Data" };
  return <section aria-labelledby="condition-title" className="resource">
    <h3 id="condition-title">About dysphagia</h3>
    {data ? <>
      <p>{data.description} <a href={data.primary.url} target="_blank" rel="noreferrer">NIDCD fact sheet (PDF) ↗</a></p>
      <p>{data.research} {data.scope}</p>
      <div className="small">
        <a href={data.related.url} target="_blank" rel="noreferrer">{data.related.title} ↗</a>
        <span className="muted"> · {data.related.publisher} · {provenance[data.related.provenance]}</span>
      </div>
    </> : <p className="small muted">{error ? "The condition overview is unavailable." : "Loading condition overview…"}</p>}
  </section>;
}
