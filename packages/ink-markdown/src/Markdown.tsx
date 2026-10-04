// tsx applies an app's tsconfig only to that app's files, so run from source
// this file would fall back to classic JSX and need `React` in scope.
/** @jsxRuntime automatic */
import { Box, Text } from "ink";
import { parseBlocks, type Block, type Span } from "./markdown-parser.js";

/**
 * Renders the parsed markdown from `markdown-parser.ts` as Ink components.
 *
 * Styling is restrained on purpose: a terminal already has a colour scheme,
 * and an agent reply that arrives as a wall of magenta is harder to read than
 * plain text, not easier. Emphasis is emphasis, code is one colour, and
 * everything else stays the terminal's own foreground.
 */
export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </Box>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "blank":
      return <Text> </Text>;

    case "rule":
      return <Text dimColor>────────</Text>;

    case "heading":
      return (
        <Text bold color={block.level <= 2 ? "cyan" : undefined}>
          <Spans spans={block.spans} />
        </Text>
      );

    case "list":
      return (
        <Box>
          <Text dimColor>{block.marker} </Text>
          <Text>
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "quote":
      return (
        <Box>
          <Text dimColor>│ </Text>
          <Text dimColor>
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "code":
      // Indented rather than boxed: a border would wrap badly on the narrow
      // terminals this is most likely to run in.
      return (
        <Box flexDirection="column" marginY={block.lines.length ? 0 : 0}>
          {block.language && <Text dimColor>{block.language}</Text>}
          {block.lines.map((line, index) => (
            <Text key={index} color="yellow">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      );

    case "table":
      return <Table header={block.header} rows={block.rows} />;

    case "paragraph":
      return (
        <Text>
          <Spans spans={block.spans} />
        </Text>
      );
  }
}

const MAX_COLUMN_WIDTH = 60;

/**
 * Columns as wide as their longest cell, up to a cap; longer cells wrap
 * inside their column.
 * ponytail: widths count characters, so emoji and CJK text misalign a
 * little. Upgrade: measure with string-width.
 */
function Table({ header, rows }: { header: Span[][]; rows: Span[][][] }) {
  const length = (cell: Span[] = []) => cell.reduce((sum, span) => sum + span.text.length, 0);
  const widths = header.map((cell, column) =>
    Math.min(MAX_COLUMN_WIDTH, Math.max(length(cell), ...rows.map((row) => length(row[column])))),
  );

  const row = (cellsOfRow: Span[][], key: number, bold = false) => (
    <Box key={key}>
      {widths.map((width, column) => (
        <Box key={column} width={width} marginRight={2} flexShrink={column === widths.length - 1 ? 1 : 0}>
          <Text bold={bold}>
            <Spans spans={cellsOfRow[column] ?? []} />
          </Text>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {row(header, -1, true)}
      <Text dimColor wrap="truncate">{widths.map((width) => "─".repeat(width)).join("  ")}</Text>
      {rows.map((cellsOfRow, index) => row(cellsOfRow, index))}
    </Box>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold}
          italic={span.italic}
          strikethrough={span.strike}
          underline={span.link}
          color={span.code ? "yellow" : undefined}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}
