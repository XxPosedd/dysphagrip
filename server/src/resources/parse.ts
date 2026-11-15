// Dependency-free parsers for the two vetted source formats.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

export const clean = (s: string) =>
  decodeEntities(stripTags(s)).replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();

/** Shorten to at most `max` characters at a sentence or word boundary. */
export function truncate(s: string, max = 320): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
}

/** Detects interstitial bot-challenge pages. We never try to get past one; the source is skipped instead. */
export function looksLikeBotChallenge(html: string): boolean {
  return /cf-chl|challenge-platform|Just a moment\.\.\.|captcha|Access Denied/i.test(html.slice(0, 20_000));
}

export interface ParsedPage {
  title: string;
  summary: string;
  lastUpdated: string | null;
}

/** NIDCD (Drupal) page: <title>, meta description, optional "Last Updated Date" <time datetime>. */
export function parseNidcdPage(html: string): ParsedPage {
  if (looksLikeBotChallenge(html)) throw new Error("Received a bot-challenge page; source skipped");
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!rawTitle) throw new Error("Page has no <title>");
  const title = clean(rawTitle).replace(/\s*\|\s*NIDCD\s*$/i, "");
  if (/isn.t available|not found/i.test(title)) throw new Error("Page no longer exists");

  const meta =
    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i)?.[1];
  const summary = meta ? truncate(clean(meta).replace(/^\[back to infographic\]\s*/i, "")) : "";
  if (!summary) throw new Error("Page has no description; refusing to invent a summary");

  const time = html.match(/Last Updated Date:[\s\S]{0,200}?<time[^>]*datetime=["']([^"']+)["']/i)?.[1];
  const lastUpdated = time && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : null;
  return { title, summary, lastUpdated };
}

export interface MedlinePlusTopic {
  url: string;
  title: string;
  altTitles: string[];
  organization: string;
  summary: string;
}

/** MedlinePlus web-service XML (nlmSearchResult). Content fields are HTML-escaped HTML. */
export function parseMedlinePlusXml(xml: string): MedlinePlusTopic[] {
  if (!/<nlmSearchResult/.test(xml)) throw new Error("Unexpected MedlinePlus response");
  const docs = [...xml.matchAll(/<document[^>]*\burl="([^"]+)"[^>]*>([\s\S]*?)<\/document>/g)];
  return docs.map(([, url, body]) => {
    const fields = (name: string) =>
      [...body.matchAll(new RegExp(`<content name="${name}">([\\s\\S]*?)</content>`, "g"))].map((m) => decodeEntities(m[1]));
    const fullSummary = fields("FullSummary")[0] ?? "";
    const firstParagraph = fullSummary.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? fullSummary;
    return {
      url: decodeEntities(url),
      title: clean(fields("title")[0] ?? ""),
      altTitles: fields("altTitle").map(clean),
      organization: clean(fields("organizationName")[0] ?? ""),
      summary: truncate(clean(firstParagraph)),
    };
  });
}
