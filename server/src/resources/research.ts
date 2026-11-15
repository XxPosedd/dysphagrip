import type { BrightDataClient } from "../integrations/brightdata.js";
import { clean } from "./parse.js";

interface Study {
  id: string;
  title: string;
  authors: string;
  year: number;
  journal: string;
  doi: string;
  url: string;
  summary: string;
  topic: string;
}

type Provenance = "bright_data_live" | "bright_data_cached" | "curated";
type ResearchStatus = "live" | "cached" | "partial" | "unavailable" | "unconfigured";
interface StudyResult extends Study {
  provenance: Provenance;
  retrievedAt: string | null;
}
interface ResearchResult {
  studies: StudyResult[];
  brightData: { configured: boolean; status: ResearchStatus };
}

const CATALOG: Study[] = [
  {
    id: "40040047", doi: "10.1109/EMBC53108.2024.10782007", url: "https://pubmed.ncbi.nlm.nih.gov/40040047/",
    title: "Detection of Pharyngolaryngeal Activities in Real-World Settings Using Wearable Sensors",
    authors: "Lila Gravellier et al.", year: 2024, journal: "IEEE Engineering in Medicine and Biology Conference",
    topic: "Wearable activity detection",
    summary: "Researchers paired a neck microphone with an accelerometer to study swallowing, voice and airway-defense events. They evaluated their model on seven hours of recordings from 42 healthy participants.",
  },
  {
    id: "28495001", doi: "10.1016/j.cmpb.2017.03.009", url: "https://pubmed.ncbi.nlm.nih.gov/28495001/",
    title: "A comparison between swallowing sounds and vibrations in patients with dysphagia",
    authors: "Faezeh Movahedi et al.", year: 2017, journal: "Computer Methods and Programs in Biomedicine",
    topic: "Audio and movement",
    summary: "The team compared 881 swallows from 72 patients undergoing videofluoroscopy. The microphone and accelerometer captured different frequency patterns during the same swallows.",
  },
  {
    id: "24290916", doi: "10.1016/j.compbiomed.2013.10.005", url: "https://pubmed.ncbi.nlm.nih.gov/24290916/",
    title: "Baseline characteristics of cervical auscultation signals during various head maneuvers",
    authors: "I. Jestrović et al.", year: 2013, journal: "Computers in Biology and Medicine",
    topic: "Head movement",
    summary: "Fifty-six healthy adults performed six head movements without swallowing. The researchers measured how the movements affected neck recordings, providing a comparison for experiments that label head motion separately.",
  },
];

const query = new URLSearchParams({
  filter: CATALOG.map((study) => "doi:" + study.doi).join(","),
  select: "DOI,title,author,container-title,published", rows: String(CATALOG.length),
});
const crossrefRequest = "https://api.crossref.org/works?" + query;

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  "container-title"?: string[];
  author?: { family?: string; given?: string }[];
  published?: { "date-parts"?: number[][] };
}

export function createResearchReader(client: Pick<BrightDataClient, "fetchPage"> | null, now = Date.now) {
  const cached = new Map<string, StudyResult>();
  let nextRefresh = 0;
  let pending: Promise<ResearchResult> | undefined;

  function result(fresh = new Set<string>()): ResearchResult {
    const studies = CATALOG.map((study): StudyResult => {
      const saved = cached.get(study.id);
      if (!saved) return { ...study, provenance: "curated", retrievedAt: null };
      return { ...saved, provenance: fresh.has(study.id) ? "bright_data_live" : "bright_data_cached" };
    });
    let status: ResearchStatus = "unconfigured";
    if (client) {
      if (fresh.size === CATALOG.length) status = "live";
      else if (cached.size === 0) status = "unavailable";
      else if (fresh.size === 0 && cached.size === CATALOG.length) status = "cached";
      else status = "partial";
    }
    return { studies, brightData: { configured: !!client, status } };
  }

  async function refresh(): Promise<ResearchResult> {
    const fresh = new Set<string>();
    try {
      const payload = JSON.parse(await client!.fetchPage(crossrefRequest));
      if (payload.status === "ok" && Array.isArray(payload.message?.items)) {
        for (const entry of payload.message.items as CrossrefWork[]) {
          const study = CATALOG.find((s) => s.doi.toLowerCase() === entry?.DOI?.toLowerCase());
          const title = entry?.title?.[0];
          const journal = entry?.["container-title"]?.[0];
          const author = entry?.author?.[0];
          const year = entry?.published?.["date-parts"]?.[0]?.[0];
          if (!study || typeof title !== "string" || typeof journal !== "string" ||
              typeof author?.family !== "string" || typeof year !== "number" || !Number.isInteger(year)) continue;
          const firstAuthor = [author.given, author.family].filter(Boolean).join(" ");
          cached.set(study.id, {
            ...study, title: clean(title), journal: clean(journal), year,
            authors: clean(firstAuthor) + (entry.author!.length > 1 ? " et al." : ""),
            retrievedAt: new Date(now()).toISOString(), provenance: "bright_data_live",
          });
          fresh.add(study.id);
        }
      }
    } catch {
      // Preserve the last successful citation and its original retrieval time.
    }
    nextRefresh = now() + (fresh.size === CATALOG.length ? 86_400_000 : 600_000);
    return result(fresh);
  }

  return async (): Promise<ResearchResult> => {
    if (!client || now() < nextRefresh) return result();
    if (!pending) pending = refresh().finally(() => { pending = undefined; });
    return pending;
  };
}
