/**
 * Just enough markdown to read an agent reply in a terminal.
 *
 * The agent writes markdown because the web app renders it; the TUI showed it
 * raw, so `**this**` and fenced code arrived as literal punctuation. A full
 * CommonMark implementation is not the answer — the terminal cannot show a
 * table or an image anyway, and every dependency here is one the TUI carries
 * forever. What matters is that emphasis, headings, lists, and code blocks
 * read as themselves.
 *
 * Parsing lives here and rendering in `Markdown.tsx`, so the interesting half
 * is testable without a terminal.
 *
 * Deliberately unsupported: tables, images, nested lists, reference links,
 * setext headings. Anything unrecognised falls through as plain text rather
 * than being swallowed — mangled output beats missing output.
 */

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; marker: string; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; language?: string; lines: string[] }
  | { kind: "rule" }
  | { kind: "blank" };

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S+)?\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseBlocks(markdown: string): Block[] {
  // An empty reply is nothing to render, not one empty line — the streaming
  // path starts every assistant turn as "".
  if (!markdown.trim()) return [];

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let fence: { marker: string; language?: string; lines: string[] } | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (const line of lines) {
    if (fence) {
      // Closing fence must match the marker that opened it, so a ``` inside a
      // ~~~ block does not end it early.
      if (line.trim().startsWith(fence.marker)) {
        blocks.push({ kind: "code", language: fence.language, lines: fence.lines });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      flushParagraph();
      fence = { marker: fenceMatch[1]!, language: fenceMatch[2], lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      blocks.push({ kind: "blank" });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        spans: parseInline(heading[2]!),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", spans: parseInline(quote[1]!) });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({
        kind: "list",
        marker: `${numbered[1]}${numbered[2]}.`,
        spans: parseInline(numbered[3]!),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "list", marker: `${bullet[1]}•`, spans: parseInline(bullet[2]!) });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();

  // A stream cut mid-code-block still has to render: show what arrived rather
  // than dropping it because the closing fence has not been typed yet.
  if (fence) blocks.push({ kind: "code", language: fence.language, lines: fence.lines });

  return blocks;
}

/**
 * Inline markers, innermost first. Code spans win over everything else — the
 * whole point of `**` inside backticks is that it stays literal.
 */
const INLINE = [
  { pattern: /`([^`]+)`/, style: { code: true } },
  { pattern: /\*\*([^*]+)\*\*/, style: { bold: true } },
  { pattern: /__([^_]+)__/, style: { bold: true } },
  { pattern: /~~([^~]+)~~/, style: { strike: true } },
  // The `(?!\s)` / `(?<!\s)` pair is what stops arithmetic reading as
  // emphasis: "2 * 3 * 4" has whitespace inside the would-be markers, so it
  // is multiplication, not italics.
  { pattern: /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/, style: { italic: true } },
  { pattern: /(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/, style: { italic: true } },
] as const;

const LINK = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/;

export function parseInline(text: string): Span[] {
  if (!text) return [];

  // Links first: their label is itself inline markup, and the URL must not be
  // scanned for emphasis (underscores in URLs are common and not italics).
  const link = LINK.exec(text);
  if (link) {
    const label = link[1] || link[2]!;
    return [
      ...parseInline(text.slice(0, link.index)),
      ...parseInline(label).map((span) => ({ ...span, link: true })),
      ...parseInline(text.slice(link.index + link[0].length)),
    ];
  }

  let earliest: { index: number; match: RegExpExecArray; style: Partial<Span> } | null = null;
  for (const { pattern, style } of INLINE) {
    const match = pattern.exec(text);
    if (match && (!earliest || match.index < earliest.index)) {
      earliest = { index: match.index, match, style };
    }
  }

  if (!earliest) return [{ text }];

  const { match, style } = earliest;
  const inner = match[1] ?? "";

  return [
    ...parseInline(text.slice(0, match.index)),
    // Code spans are literal: no further parsing inside them.
    ...(style.code
      ? [{ text: inner, ...style }]
      : parseInline(inner).map((span) => ({ ...span, ...style }))),
    ...parseInline(text.slice(match.index + match[0].length)),
  ].filter((span) => span.text !== "");
}
