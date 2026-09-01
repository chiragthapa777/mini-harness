import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";

/**
 * HTML parsing for this package.
 *
 * Cheerio does the parsing — real tolerant HTML parsing with CSS selectors and
 * entity decoding, in ~1 MB and with no browser or DOM emulation. Regexes over
 * markup were the alternative and they lose to malformed pages, nested tags,
 * and attribute-order changes, which is exactly what scraping DuckDuckGo and
 * arbitrary article pages is made of.
 */

export function parse(html: string): CheerioAPI {
  return load(html);
}

/** Collapse all whitespace, including newlines, to single spaces. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Trim each line and squeeze runs of blank lines down to one. */
export function normalizeLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type { CheerioAPI };
