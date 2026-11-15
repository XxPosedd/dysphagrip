/**
 * Vetted public-interest sources (United States). Every entry was checked on 2026-11-14 for:
 *   - permission: public-domain US-government content that may be linked/reused,
 *   - robots.txt: the page path is not disallowed,
 *   - no bot challenge: the page is served normally (nothing is bypassed),
 *   - no intervention advice in the official description (the app must not surface treatment advice).
 *
 * Rejected during vetting (do not add without re-checking):
 *   - asha.org: Terms of Use prohibit robots/spiders/scrapers without written permission.
 *   - swallowingdisorderfoundation.com: answers automated requests with 403 (deliberate block).
 *   - dysphagiaresearch.org: Cloudflare bot challenge.
 *   - nidcd.nih.gov 2018 aging news item: its description recommends an exercise programme (intervention).
 *   - nidcd.nih.gov/health/voice-speech-and-language: no page description; summary would have to be invented.
 *
 * LIVE FINDING 2026-11-14: Bright Data refuses www.nidcd.nih.gov ("classified as Government and blocked by Bright Data
 * as it might breach Bright Data usage policy"); its docs state government websites are blocked across all networks.
 * The NIDCD pages therefore cannot be collected through Bright Data. They are kept here only until replacement
 * non-government sources are vetted; every refresh reports them as refused rather than storing anything.
 */

export const NIDCD_LICENSE =
  "U.S. government work in the public domain (NIDCD website policies). Linking does not imply NIDCD endorsement.";
export const MEDLINEPLUS_LICENSE =
  "MedlinePlus health topic summary: U.S. government work in the public domain. Source: MedlinePlus, National Library of Medicine.";

/** Pages collected through Bright Data's Web Unlocker API (no official API exists for these). */
export const NIDCD_PAGES = [
  "https://www.nidcd.nih.gov/glossary/dysphagia",
  "https://www.nidcd.nih.gov/glossary/swallowing-disorders",
  "https://www.nidcd.nih.gov/about/nearly-1-12-children-ages-3-17-has-disorder-related-voice-speech-language-or-swallowing-text-version",
] as const;

/** Hosts Bright Data may be pointed at. Anything else is refused before any request is made. */
export const BRIGHT_DATA_ALLOWED_HOSTS = new Set(["www.nidcd.nih.gov"]);

/** Collected through MedlinePlus' official web service (preferred over scraping). */
export const MEDLINEPLUS_QUERIES = [
  { db: "healthTopics", term: '"swallowing disorders"', language: "en" },
  { db: "healthTopicsSpanish", term: "disfagia", language: "es" },
] as const;

/** A MedlinePlus result is kept only if its title or alternate titles are about swallowing. */
export const SWALLOWING_TOPIC = /swallow|dysphag|tragar|degluci|disfag/i;

/** Polite delay between page fetches. */
export const FETCH_DELAY_MS = 2000;
