/**
 * First import of index.js. Top-level await here blocks every later import, so
 * Secret Manager values are in process.env before onedrive.js, google.js, and the
 * rest read their config at module load. No-op on the Mac (.env via --env-file).
 */
import { loadSecrets } from "./secrets.js";

await loadSecrets();
