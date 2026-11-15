// Collects the vetted public resources and stores them in Neon.
// Usage: npm run resources:refresh   (needs DATABASE_URL; BRIGHTDATA_API_TOKEN + BRIGHTDATA_ZONE for the NIDCD pages)
// Run it manually or on a schedule. It is deliberately NOT exposed as a public HTTP endpoint.
import "../src/env.js";
import { brightDataFromEnv } from "../src/integrations/brightdata.js";
import { collectResources } from "../src/resources/collect.js";
import { resourceStoreFromEnv } from "../src/resources/store.js";

const store = resourceStoreFromEnv();
if (!store) {
  console.error("DATABASE_URL is not set: nowhere to store resources. See README → Neon.");
  process.exit(1);
}

const report = await collectResources({ brightData: brightDataFromEnv(), log: (m) => console.log(m) });
const saved = await store.upsert(report.resources);

console.log(`\nStored ${saved} resource(s) in Neon.`);
if (report.skippedBrightData) console.log("Note: NIDCD pages were skipped because Bright Data is not configured.");
if (report.errors.length) {
  console.log(`${report.errors.length} source(s) failed:`);
  for (const e of report.errors) console.log(`  - ${e.source}: ${e.error}`);
  process.exitCode = 2;
}
