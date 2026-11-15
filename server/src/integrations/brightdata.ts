/**
 * Bright Data integration boundary.
 * Implement only after selecting a permitted public-interest source/dataset.
 * Respect source terms, robots rules, rate limits, attribution, and privacy.
 * Never scrape login-gated or personal health information.
 */
export type PublicResource = { title: string; sourceUrl: string; retrievedAt: string };

export async function getPublicResources(): Promise<PublicResource[]> {
  if (!process.env.BRIGHTDATA_API_TOKEN || !process.env.BRIGHTDATA_DATASET_ID) return [];
  // TODO: implement the exact Bright Data product/API selected by the team.
  // Do not invent an endpoint or report success until tested against real credentials.
  return [];
}
