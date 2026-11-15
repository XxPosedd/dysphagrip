import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// `npm run dev --prefix server` sets cwd to server/, so the default
// `dotenv/config` would miss the repository-root .env. Load it explicitly.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });
dotenv.config(); // also allow server/.env, without overriding values already set
