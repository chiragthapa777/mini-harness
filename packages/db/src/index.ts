import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Lazily created singleton pool. DATABASE_URL is read on first use. */
export function db(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const result = await db().query<R>(text, params);
  return result.rows;
}

/** pgvector wants a literal like '[0.1,0.2,...]', not a JS array. */
export function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function close(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
