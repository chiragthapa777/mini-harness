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

    case "paragraph":
      return (
        <Text>
          <Spans spans={block.spans} />
        </Text>
      );
  }
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
