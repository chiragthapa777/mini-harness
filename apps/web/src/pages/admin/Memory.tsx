import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  DataTable,
  PageHeader,
  Pager,
  Toolbar,
  inputClass,
  type Column,
} from "../../components/admin/Table.js";
import { adminListFacts, adminUploadFacts, type AdminFact } from "../../lib/api.js";
import { useAdmin } from "./AdminLayout.js";

const KINDS = ["fact", "profile", "domain_rule", "data_dictionary"] as const;
const LIMIT = 25;

/**
 * Semantic memory for one user, admin-viewable for any user. Merged-away facts
 * are hidden by default and shown with the id they were merged into, so a dedup
 * pass can be audited rather than taken on trust.
 */
export function AdminMemory() {
  const { users } = useAdmin();
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [facts, setFacts] = useState<AdminFact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id);
  }, [users, userId]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await adminListFacts(userId, {
        kind: kind || undefined,
        includeArchived,
        limit: LIMIT,
        offset,
      });
      setFacts(result.facts);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load memory");
    } finally {
      setLoading(false);
    }
  }, [userId, kind, includeArchived, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Text files only. Chunking, source labels and embeddings all happen server-side. */
  async function upload(file: File) {
    setUploading(file.name);
    setError(null);
    try {
      const result = await adminUploadFacts(userId, file.name, await file.text(), kind || undefined);
      setOffset(0);
      await load();
      setUploading(`${file.name} — ${result.chunks} chunk(s) stored`);
      setTimeout(() => setUploading(null), 4000);
    } catch (err) {
      setUploading(null);
      setError(err instanceof Error ? err.message : "upload failed");
    }
  }

  const columns: Column<AdminFact>[] = [
    { header: "Kind", nowrap: true, cell: (fact) => <Badge>{fact.kind}</Badge> },
    {
      header: "Content",
      width: "max-w-xl",
      cell: (fact) => (
        <div className="space-y-1">
          <p className="whitespace-pre-wrap">{fact.content}</p>
          {fact.archived_at && (
            <Badge tone="amber">
              {fact.superseded_by ? `merged into #${fact.superseded_by}` : "archived"}
            </Badge>
          )}
        </div>
      ),
    },
    {
      header: "Source",
      cell: (fact) => <span className="font-mono text-xs text-neutral-500">{fact.source ?? "—"}</span>,
    },
    {
      header: "Updated",
      nowrap: true,
      cell: (fact) => (
        <span className="text-neutral-500">{new Date(fact.updated_at).toLocaleString()}</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Memory"
        description="Durable facts the agent has kept, per user."
      >
        <label className="cursor-pointer rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs dark:border-neutral-800">
          Upload .txt/.md
          <input
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            className="hidden"
            disabled={!userId}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset the input so re-picking the same file fires again.
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </PageHeader>

      <Toolbar>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.email}
            </option>
          ))}
        </select>

        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
          }}
          className={inputClass}
        >
          <option value="">all kinds</option>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        {/* Without this, a merge is indistinguishable from losing the fact. */}
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => {
              setIncludeArchived(e.target.checked);
              setOffset(0);
            }}
          />
          show merged
        </label>
      </Toolbar>

      {uploading && <p className="text-xs text-neutral-500">{uploading}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <DataTable
        columns={columns}
        rows={facts}
        rowKey={(fact) => fact.id}
        loading={loading}
        empty="No memory for this user yet."
      />
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </div>
  );
}
