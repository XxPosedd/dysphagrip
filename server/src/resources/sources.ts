/**
 * Vetted public-interest sources (United States), checked 2026-11-14 for:
 *   - permission: terms of use / content policy do not prohibit automated access, and linking is allowed,
 *   - robots.txt: the page path is not disallowed,
 *   - no bot challenge: the page is served normally (nothing is bypassed),
 *   - Bright Data reachability: a real fetch through the Web Unlocker zone succeeded,
 *   - no intervention advice in the publisher's own description (the app must not surface treatment advice).
 *
 * Only the title, the publisher's own short description, dates and the link are stored. Page bodies are not kept.
 *
 * REJECTED during vetting (re-check before adding any of these):
 *   Terms forbid robots/scrapers/automated access without written permission:
 *     asha.org, mda.org, headandneck.org (Head and Neck Cancer Alliance), apdaparkinson.org,
 *     my.clevelandclinic.org, strokeinfo.org (AbilityPath), nationalmssociety.org
 *   Terms/content policy restrict storage, reuse or even linking:
 *     cancer.org (no electronic reuse), michaeljfox.org (linking requires permission)
 *   Bot protection or blocking of automated requests:
 *     als.org, hopkinsmedicine.org, hdsa.org, mayoclinic.org (403), stroke.org (403),
 *     swallowingdisorderfoundation.com (403), dysphagiaresearch.org (Cloudflare challenge)
 *   Other: oralcancerfoundation.org (site error 526), alz.org (no swallowing page)
 *   Government sites (nidcd.nih.gov, ninds.nih.gov): public domain, but Bright Data refuses them
 *     ("classified as Government and blocked by Bright Data"; its docs: government sites are blocked on all
 *     networks). Government content comes from MedlinePlus' official API instead.
 */

export const MEDLINEPLUS_LICENSE =
  "MedlinePlus health topic summary: U.S. government work in the public domain. Source: MedlinePlus, National Library of Medicine.";

export interface BrightDataSource {
  url: string;
  publisher: string;
  /** Removed from the end of the page <title>, e.g. " | Parkinson's Foundation". */
  titleSuffix: RegExp;
  licenseNote: string;
}

const linkedOnly = (org: string) =>
  `© ${org}. DysphaGrip shows only the title and the publisher's own short description, with a link to the original page.`;

/** Pages collected through Bright Data's Web Unlocker API. */
export const BRIGHT_DATA_SOURCES: readonly BrightDataSource[] = [
  {
    url: "https://www.parkinson.org/understanding-parkinsons/non-movement-symptoms/speech-swallowing",
    publisher: "Parkinson's Foundation",
    titleSuffix: /\s*\|\s*Parkinson'?s Foundation\s*$/i,
    licenseNote: linkedOnly("Parkinson's Foundation"),
  },
  {
    url: "https://www.parkinson.org/library/fact-sheets/speech-swallowing",
    publisher: "Parkinson's Foundation",
    titleSuffix: /\s*\|\s*Parkinson'?s Foundation\s*$/i,
    licenseNote: linkedOnly("Parkinson's Foundation"),
  },
  {
    url: "https://www.spohnc.org/swallowing-assessment-for-head-and-neck-cancer-survivors-expectations-and-outcomes/",
    publisher: "SPOHNC: Support for People with Oral and Head and Neck Cancer",
    titleSuffix: /\s*\|\s*SPOHNC.*$/i,
    licenseNote: linkedOnly("SPOHNC"),
  },
];

/** Hosts Bright Data may be pointed at. Anything else is refused before any request is made. */
export const BRIGHT_DATA_ALLOWED_HOSTS = new Set(BRIGHT_DATA_SOURCES.map((s) => new URL(s.url).hostname));

/** Collected through MedlinePlus' official web service (preferred over scraping). */
export const MEDLINEPLUS_QUERIES = [
  { db: "healthTopics", term: '"swallowing disorders"', language: "en" },
  { db: "healthTopicsSpanish", term: "disfagia", language: "es" },
] as const;

/** A MedlinePlus result is kept only if its title or alternate titles are about swallowing. */
export const SWALLOWING_TOPIC = /swallow|dysphag|tragar|degluci|disfag/i;

/** Polite delay between page fetches. */
export const FETCH_DELAY_MS = 2000;
