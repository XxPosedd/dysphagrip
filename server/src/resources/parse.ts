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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Content of <meta name|property="key" content="…"> in either attribute order. */
const metaContent = (html: string, attr: "name" | "property", key: string): string | undefined => {
  const k = escapeRe(key);
  return (
    html.match(new RegExp(`<meta\\s+${attr}=["']${k}["']\\s+content=["']([^"']*)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attr}=["']${k}["']`, "i"))?.[1]
  );
};

/**
 * Generic article/page parser: <title> (minus the site suffix), the publisher's own meta description
 * (or og:description), and a last-modified date if the page states one.
 */
export function parseHtmlPage(rawHtml: string, opts: { titleSuffix?: RegExp } = {}): ParsedPage {
  if (looksLikeBotChallenge(rawHtml)) throw new Error("Received a bot-challenge page; source skipped");
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, ""); // markup inside comments is not part of the page
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!rawTitle) throw new Error("Page has no <title>");
  let title = clean(rawTitle);
  if (opts.titleSuffix) title = title.replace(opts.titleSuffix, "").trim();
  if (!title || /isn.t available|not found|page cannot be found/i.test(title)) throw new Error("Page no longer exists");

  const meta = metaContent(html, "name", "description") ?? metaContent(html, "property", "og:description");
  let summary = meta ? clean(meta).replace(/^\[back to infographic\]\s*/i, "") : "";
  if (!summary) throw new Error("Page has no description; refusing to invent a summary");
  // A publisher description cut mid-sentence by the site itself is shown with an ellipsis, not completed by us.
  if (!/[.!?…)"”]$/.test(summary)) summary = `${summary.replace(/[,;:\s]+$/, "")}…`;
  summary = truncate(summary);

  const stated =
    metaContent(html, "property", "article:modified_time") ??
    metaContent(html, "property", "og:updated_time") ??
    html.match(/Last Updated Date:[\s\S]{0,200}?<time[^>]*datetime=["']([^"']+)["']/i)?.[1];
  const lastUpdated = stated && !Number.isNaN(Date.parse(stated)) ? new Date(stated).toISOString() : null;
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
