import { guardedFetch, scrape, search } from "@mini-agent/search";
import { z } from "zod";
import type { AgentTool } from "./types.js";

/**
 * Tools are the agent's only way to touch the outside world. Anything with a
 * side effect belongs here, not in a prompt — the harness can then gate it,
 * trace it, and show it to the user.
 */

export const clock: AgentTool = {
  name: "current_time",
  description:
    "Get the current date and time, optionally in a specific timezone. " +
    "Use this instead of guessing today's date.",
  schema: z.object({
    timezone: z.string().optional().describe("IANA timezone, e.g. Asia/Kathmandu"),
  }),
  async run({ timezone }) {
    const tz = timezone as string | undefined;
    return new Date().toLocaleString("en-US", tz ? { timeZone: tz } : undefined);
  },
};

export const calculator: AgentTool = {
  name: "calculator",
  description:
    "Evaluate an arithmetic expression exactly. Supports + - * / % ( ) and ** . " +
    "Use this for any calculation rather than doing mental arithmetic.",
  schema: z.object({
    expression: z.string().describe("e.g. (1200 * 1.13) / 3"),
  }),
  async run({ expression }) {
    const expr = String(expression);
    // Arithmetic only — never hand model output to eval().
    if (!/^[\d\s+\-*/%.()]+$/.test(expr)) {
      throw new Error("expression may only contain numbers and + - * / % ( ) .");
    }
    const result = evaluate(expr);
    if (!Number.isFinite(result)) throw new Error("expression did not produce a finite number");
    // Trim IEEE dust so the model never reads 451.99999999999994 for 452.
    return String(Number(result.toPrecision(12)));
  },
};

/**
 * The three web tools are deliberately separate rather than one do-everything
 * tool: the model picks the step it needs and pays for nothing else.
 *
 *   web_search  find pages when there is no URL yet — titles, URLs, snippets
 *   scrape_url  read one normal web page, boilerplate removed
 *   fetch_url   raw bytes of anything else — JSON, APIs, plain text
 *
 * All three fetch through the guard in `@mini-agent/search`, which is the only
 * thing standing between model-chosen URLs and our own network.
 */

export const webSearch: AgentTool = {
  name: "web_search",
  description:
    "Search the web and get back titles, URLs, and short snippets. " +
    "Use this for anything current, anything you are unsure about, or whenever " +
    "you need a URL you do not already have. Snippets are only a preview — " +
    "call scrape_url on a result to actually read it.",
  schema: z.object({
    query: z.string().describe("Search terms, as you would type them into a search box"),
    maxResults: z.number().optional().describe("How many results to return (default 5)"),
  }),
  async run({ query, maxResults }) {
    const response = await search(String(query), {
      ...(typeof maxResults === "number" ? { maxResults } : {}),
    });

    if (!response.results.length) {
      return response.answer ?? `no results for: ${response.query}`;
    }

    const blocks = response.results.map(
      (result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
    );
    return [response.answer && `answer: ${response.answer}`, ...blocks]
      .filter(Boolean)
      .join("\n");
  },
};

export const scrapeUrl: AgentTool = {
  name: "scrape_url",
  description:
    "Read one web page and get its main content back as markdown, with " +
    "navigation, headers, footers, and sidebars removed. Use this to read an " +
    "article, a docs page, or any search result. Links in the text are kept, " +
    "so you can follow them with another scrape_url call.",
  schema: z.object({
    url: z.string().describe("Absolute http(s) URL"),
    maxChars: z.number().optional().describe("Truncate the content (default 8000)"),
  }),
  async run({ url, maxChars }) {
    const result = await scrape(String(url), {
      ...(typeof maxChars === "number" ? { maxChars } : {}),
    });

    const header = result.title ? `# ${result.title}\n${result.url}\n` : `${result.url}\n`;
    return `${header}\n${result.content}${result.truncated ? "\n…[truncated]" : ""}`;
  },
};

export const fetchUrl: AgentTool = {
  name: "fetch_url",
  description:
    "Fetch a URL and return its raw text, with HTML tags stripped. " +
    "Use this for JSON APIs, plain text, feeds, and anything that is not an " +
    "article — for a normal web page, scrape_url gives cleaner output.",
  schema: z.object({
    url: z.string().describe("Absolute http(s) URL"),
    maxChars: z.number().optional().describe("Truncate the result (default 4000)"),
  }),
  async run({ url, maxChars }) {
    // Scheme, private-address, redirect, and size limits all live in the guard.
    const response = await guardedFetch(String(url), { timeoutMs: 15_000 });

    const text = response.body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const limit = typeof maxChars === "number" ? maxChars : 4000;
    return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
  },
};



/**
 * Shunting-yard evaluation. A parser rather than `eval` so model output is
 * never executed, even after the character whitelist above.
 */
function evaluate(expr: string): number {
  // `**` must precede the single-character class, or it tokenizes as two `*`.
  const tokens = expr.match(/\d+\.?\d*|\*\*|[+\-*/%()]/g);
  if (!tokens) throw new Error("nothing to evaluate");

  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "**": 3 };
  const values: number[] = [];
  const ops: string[] = [];

  const apply = () => {
    const op = ops.pop();
    const b = values.pop();
    const a = values.pop();
    if (op === undefined || a === undefined || b === undefined) {
      throw new Error("malformed expression");
    }
    if ((op === "/" || op === "%") && b === 0) throw new Error("division by zero");
    values.push(
      op === "+" ? a + b
        : op === "-" ? a - b
          : op === "*" ? a * b
            : op === "/" ? a / b
              : op === "%" ? a % b
                : a ** b,
    );
  };

  // `**` is right-associative, everything else binds left to right.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\d/.test(token)) {
      values.push(Number(token));
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length && ops.at(-1) !== "(") apply();
      if (!ops.length) throw new Error("unbalanced parentheses");
      ops.pop();
    } else {
      const prec = precedence[token];
      if (prec === undefined) throw new Error(`unsupported operator: ${token}`);
      while (
        ops.length &&
        ops.at(-1) !== "(" &&
        (precedence[ops.at(-1)!] ?? 0) >= prec &&
        token !== "**"
      ) {
        apply();
      }
      ops.push(token);
    }
  }

  while (ops.length) {
    if (ops.at(-1) === "(") throw new Error("unbalanced parentheses");
    apply();
  }

  const result = values.pop();
  if (result === undefined || values.length) throw new Error("malformed expression");
  return result;
}

/** Tools that need no per-user context. Memory tools are built per run. */
export const defaultTools: AgentTool[] = [clock, calculator, webSearch, scrapeUrl, fetchUrl];