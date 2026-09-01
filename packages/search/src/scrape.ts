import type { AnyNode, Element } from "domhandler";
import { searchConfig } from "./config.js";
import { collapse, normalizeLines, parse, type CheerioAPI } from "./html.js";
import { guardedFetch } from "./http.js";
import type { ScrapeOptions, ScrapeResult } from "./types.js";

/**
 * Pull the readable body of a page out of its chrome.
 *
 * This is the counterpart to `fetch_url`, not a replacement for it. `fetch_url`
 * hands back whatever bytes are at a URL, which is what you want for JSON and
 * plain text; `scrape` throws away nav, headers, footers, and sidebars, and
 * returns the article as markdown. Links survive as markdown so the agent can
 * keep following the trail from what it just read.
 */

/** Never content. Removed before anything else runs. */
const CHROME = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "form",
  "button",
  "select",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
].join(",");

/** Block elements that end a paragraph. */
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "ul",
  "ol",
  "dl",
  "dd",
  "dt",
  "table",
  "tr",
  "blockquote",
  "figure",
  "figcaption",
  "hr",
]);

export async function scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const config = searchConfig();
  const maxChars = options.maxChars ?? config.scrapeMaxChars;

  const response = await guardedFetch(url, {
    timeoutMs: config.timeoutMs,
    signal: options.signal,
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
  });

  // Non-HTML has no chrome to strip — hand it back rather than mangling it.
  if (!/html|xml/i.test(response.contentType)) {
    return finish(response.url, "", collapse(response.body), maxChars, response.truncated);
  }

  const $ = parse(response.body);
  return finish(
    response.url,
    extractTitle($),
    extractContent($, response.url),
    maxChars,
    response.truncated,
  );
}

function finish(
  url: string,
  title: string,
  content: string,
  maxChars: number,
  fetchTruncated: boolean,
): ScrapeResult {
  const truncated = fetchTruncated || content.length > maxChars;
  return {
    url,
    title,
    content: content.length > maxChars ? content.slice(0, maxChars).trimEnd() : content,
    truncated,
  };
}

export function extractTitle($: CheerioAPI): string {
  const title = collapse($("title").first().text());
  if (title) return title;
  return collapse($("h1").first().text());
}

/**
 * Prefer the semantic container when the page has one. Sites that bother to
 * mark up `<article>` or `<main>` almost always mark it up correctly, and
 * honouring that removes more boilerplate than any heuristic we would write
 * over the whole body.
 */
export function extractContent($: CheerioAPI, baseUrl: string): string {
  $(CHROME).remove();

  const root =
    firstNonEmpty($, "article") ?? firstNonEmpty($, "main") ?? $("body").first().get(0) ?? undefined;
  if (!root) return "";

  return normalizeLines(render($, root as Element, baseUrl));
}

function firstNonEmpty($: CheerioAPI, selector: string): Element | undefined {
  const match = $(selector)
    .toArray()
    .find((element) => collapse($(element).text()).length > 200);
  return (match ?? $(selector).first().get(0) ?? undefined) as Element | undefined;
}

/**
 * Walk the tree once and emit markdown. Structure the model actually uses —
 * headings, lists, links, code — survives; everything else becomes paragraphs.
 */
function render($: CheerioAPI, node: AnyNode, baseUrl: string): string {
  if (node.type === "text") return "data" in node ? node.data.replace(/\s+/g, " ") : "";
  if (!isElement(node)) return "";

  const tag = node.tagName.toLowerCase();
  const children = () => node.children.map((child: AnyNode) => render($, child, baseUrl)).join("");

  if (tag === "br") return "\n";
  if (tag === "pre") {
    const code = $(node).text().replace(/\n+$/, "");
    return code.trim() ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : "";
  }
  if (tag === "code") {
    const code = collapse($(node).text());
    return code ? ` \`${code}\` ` : "";
  }
  if (/^h[1-6]$/.test(tag)) {
    const text = collapse(children());
    return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
  }
  if (tag === "li") {
    const text = collapse(children());
    return text ? `\n- ${text}` : "";
  }
  if (tag === "a") {
    return link($, node, children(), baseUrl);
  }
  if (tag === "img") {
    const alt = collapse($(node).attr("alt") ?? "");
    return alt ? ` ![${alt}] ` : "";
  }

  const inner = children();
  return BLOCK.has(tag) ? `\n\n${inner}\n\n` : inner;
}

function link($: CheerioAPI, node: Element, inner: string, baseUrl: string): string {
  const text = collapse(inner);
  if (!text) return "";

  const href = $(node).attr("href");
  if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) return text;

  try {
    return `[${text}](${new URL(href, baseUrl).href})`;
  } catch {
    return text;
  }
}

function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}
