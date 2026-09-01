import { Fragment, type ReactNode } from "react";

/**
 * The admin table kit.
 *
 * Every admin page shows the same thing — a filtered, paginated list of rows,
 * some of which expand — so the table is one component rather than five
 * hand-rolled `<table>`s that drift apart. What each page supplies is its
 * columns and its rows; alignment, density, the empty state, the loading
 * state, and the pager are not decisions worth making five times.
 */

export interface Column<T> {
  /** Header text. */
  header: string;
  /** Cell contents for one row. */
  cell(row: T): ReactNode;
  /** Right-align numbers; left is the default and right for anything numeric. */
  align?: "left" | "right";
  /** Stops a long cell from stretching the table — the value still shows on hover. */
  width?: string;
  /** Keeps dates and counts on one line. */
  nowrap?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  loading?: boolean;
  /** Shown instead of rows when there are none and nothing is loading. */
  empty?: string;
  /** Row click toggles the expansion; returning nothing means the row does not expand. */
  expanded?(row: T): ReactNode | null;
  isExpanded?(row: T): boolean;
  onRowClick?(row: T): void;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty = "Nothing here yet.",
  expanded,
  isExpanded,
  onRowClick,
}: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60">
            {columns.map((column) => (
              <th
                key={column.header}
                className={`px-3 py-2 text-xs font-medium tracking-wide text-neutral-500 uppercase ${
                  column.align === "right" ? "text-right" : ""
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = isExpanded?.(row) ?? false;
            const detail = open ? expanded?.(row) : null;

            return (
              // A Fragment, not a wrapper element: the expansion has to be a
              // sibling `<tr>`, and a `<tr>` cannot contain another one.
              <Fragment key={rowKey(row)}>
                <RowCells
                  row={row}
                  columns={columns}
                  clickable={Boolean(onRowClick)}
                  open={open}
                  onClick={() => onRowClick?.(row)}
                />
                {detail && (
                  <tr className="border-b border-neutral-200 dark:border-neutral-800">
                    <td
                      colSpan={columns.length}
                      className="bg-neutral-50 px-3 py-3 dark:bg-neutral-900/40"
                    >
                      {detail}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-neutral-400">
                {loading ? "Loading…" : empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Split out because a `<tr>` cannot contain another `<tr>`: the expansion row
 * has to be a sibling, and React needs both to come from one map.
 */
function RowCells<T>({
  row,
  columns,
  clickable,
  open,
  onClick,
}: {
  row: T;
  columns: Column<T>[];
  clickable: boolean;
  open: boolean;
  onClick(): void;
}) {
  return (
    <tr
      onClick={clickable ? onClick : undefined}
      className={`border-b border-neutral-200 last:border-0 dark:border-neutral-800 ${
        clickable ? "cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/60" : ""
      } ${open ? "bg-neutral-50 dark:bg-neutral-900/60" : ""}`}
    >
      {columns.map((column) => (
        <td
          key={column.header}
          className={`px-3 py-2 align-top ${column.align === "right" ? "text-right" : ""} ${
            column.nowrap ? "whitespace-nowrap" : ""
          } ${column.width ?? ""}`}
        >
          {column.cell(row)}
        </td>
      ))}
    </tr>
  );
}

/**
 * Offset paging, driven by the server's total. Always rendered, even on a
 * single page: a table whose controls appear and disappear as the data changes
 * is harder to use than one where they are always in the same place.
 */
export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange(offset: number): void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between text-xs text-neutral-500">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
          className="rounded-lg border border-neutral-200 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-800 dark:hover:bg-neutral-900"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
          className="rounded-lg border border-neutral-200 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-800 dark:hover:bg-neutral-900"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** The filter row above a table. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export const inputClass =
  "rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900";

export const buttonClass =
  "rounded-lg border border-neutral-200 px-2.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-800 dark:hover:bg-neutral-900";

type Tone = "neutral" | "green" | "red" | "amber" | "blue";

const TONES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  green: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",
  red: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
};

/** Status as a chip: scannable down a column in a way coloured text is not. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** Page heading plus whatever the page puts on the right (counts, actions). */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-base font-semibold">{title}</h1>
        {description && <p className="text-xs text-neutral-500">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Labelled block of preformatted text — payloads, errors, prompts. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white text-xs dark:border-neutral-800 dark:bg-neutral-950">
      <div className="border-b border-neutral-200 px-2 py-1 font-medium text-neutral-500 dark:border-neutral-800">
        {label}
      </div>
      <pre className="max-h-64 overflow-auto px-2 py-2 font-mono break-words whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
        {value}
      </pre>
    </div>
  );
}
