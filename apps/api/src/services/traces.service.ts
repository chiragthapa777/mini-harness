import { query } from "@mini-agent/db";

export interface TraceRow {
  id: string;
  conversation_id: string | null;
  user_id: string;
  model: string;
  prompt_version: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number | null;
  stop_reason: string | null;
  error: string | null;
  created_at: Date;
}

export interface TraceDetailRow extends TraceRow {
  system_prompt: string | null;
  steps: unknown;
}

export interface TraceFilters {
  userId?: string;
  model?: string;
  errorOnly?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

const TRACE_COLUMNS = `id::text, conversation_id::text, user_id, model, prompt_version,
  iterations, input_tokens, output_tokens, latency_ms, stop_reason, error, created_at`;

/**
 * LLM Ops listing — filtered, paginated view over every trace. Filters are
 * ANDed and each is optional, so the admin panel can narrow by any
 * combination of user, model, error status, and date range.
 */
export async function listTraces(
  filters: TraceFilters = {},
): Promise<{ traces: TraceRow[]; total: number }> {
  const { where, params } = buildWhere(filters);
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [traces, countRows] = await Promise.all([
    query<TraceRow>(
      `SELECT ${TRACE_COLUMNS}
         FROM traces
        ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query<{ count: string }>(`SELECT count(*)::text FROM traces ${where}`, params),
  ]);

  return { traces, total: Number(countRows[0]?.count ?? 0) };
}

export async function getTrace(id: string): Promise<TraceDetailRow | undefined> {
  const [row] = await query<TraceDetailRow>(
    `SELECT ${TRACE_COLUMNS}, system_prompt, steps FROM traces WHERE id = $1`,
    [id],
  );
  return row;
}

function buildWhere(filters: TraceFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.userId) {
    params.push(filters.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (filters.model) {
    params.push(`%${filters.model}%`);
    clauses.push(`model ILIKE $${params.length}`);
  }
  if (filters.errorOnly) {
    clauses.push(`error IS NOT NULL`);
  }
  if (filters.from) {
    params.push(filters.from);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`created_at <= $${params.length}`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
