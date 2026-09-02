import { close, query } from "@mini-agent/db";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/**
 * Applies `packages/db/schema.sql` to whatever `DATABASE_URL` points at.
 *
 * The schema is written to be idempotent — `CREATE TABLE IF NOT EXISTS`,
 * `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` — so running it on
 * every deploy is the migration story: no tracking table, no ordering, and a
 * fresh database and a five-versions-old one both end up in the same place.
 *
 * It lives in the API image so a deployment has a way to reach the schema
 * without checking out the repo: `docker compose run --rm api pnpm migrate`,
 * or the one-shot `db-init` service in `deploy/docker-compose.yml`.
 *
 * Postgres compaction, destructive column changes, and data backfills are
 * deliberately *not* here. Anything that cannot be re-run safely does not
 * belong in a file that runs on every boot.
 */
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../../packages/db/schema.sql");

const sql = await readFile(schemaPath, "utf8");

try {
  // One statement in pg's simple-query protocol can hold the whole file, which
  // also makes it a single implicit transaction.
  await query(sql);
  logger.info(`schema applied from ${schemaPath}`);
} catch (err) {
  logger.error("schema failed to apply", err);
  process.exitCode = 1;
} finally {
  await close();
}
