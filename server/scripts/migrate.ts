// Applies src/schema.sql to the Neon database in DATABASE_URL.
// Usage: npm run db:migrate --prefix server
import "../src/env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and add your Neon connection string.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = await readFile(path.resolve(here, "../src/schema.sql"), "utf8");
const sql = neon(url);

const statements = schema
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  await sql.query(statement);
}
console.log(`Applied ${statements.length} schema statements.`);
