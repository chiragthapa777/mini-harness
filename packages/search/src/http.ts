import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The one way this package touches the network.
 *
 * Every URL here ultimately comes from model output or from a search result,
 * so it is untrusted input. Without a guard, `fetch_url`-shaped tools are an
 * SSRF primitive: the agent runs inside our network, so `http://localhost:5433`
 * is our Postgres and `http://169.254.169.254/` is the cloud metadata endpoint.
 * Everything below exists to keep an outbound fetch pointed at the public
 * internet.
 */

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000;

export interface GuardedFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Opt out of the private-address check — only for a self-hosted backend. */
  allowPrivateHosts?: boolean;
}

export interface GuardedResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

/**
 * Fetch a URL with the scheme, address, redirect, size, and time limits applied.
 * Redirects are followed by hand so every hop is re-validated — a permitted
 * host is otherwise free to bounce us straight at 127.0.0.1.
 */
export async function guardedFetch(
  input: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10_000,
    signal,
    maxBytes = MAX_BYTES,
    allowPrivateHosts = false,
  } = options;

  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let target = await assertPublicUrl(input, allowPrivateHosts);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(target, {
      method: hop === 0 ? method : "GET",
      headers: { "user-agent": USER_AGENT, ...headers },
      body: hop === 0 ? body : undefined,
      redirect: "manual",
      signal: abort,
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${response.status} redirect without a Location header`);
      // Cancel the body we are not going to read, or the socket leaks.
      await response.body?.cancel();
      target = await assertPublicUrl(new URL(location, target).href, allowPrivateHosts);
      continue;
    }

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const { text, truncated } = await readCapped(response, maxBytes);
    return {
      url: target,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: text,
      truncated,
    };
  }

  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

/**
 * Reject anything that is not a public http(s) endpoint. Hostnames are resolved
 * first: the check has to run against the address we will actually connect to,
 * not the label, or `internal.example.com -> 10.0.0.5` walks straight through.
 */
export async function assertPublicUrl(input: string, allowPrivateHosts = false): Promise<string> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`not a valid URL: ${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https URLs are supported");
  }
  if (allowPrivateHosts) return url.href;

  // Strip the brackets Node keeps on IPv6 literals in `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`refusing to fetch a private address: ${url.hostname}`);
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`refusing to fetch a private address: ${url.hostname}`);
  }

  const addresses = isIP(host)
    ? [host]
    : await resolveHost(host).catch(() => {
        throw new Error(`could not resolve host: ${url.hostname}`);
      });

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`refusing to fetch a private address: ${url.hostname} (${address})`);
    }
  }

  return url.href;
}

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error("no addresses");
  return records.map((record) => record.address);
}

/** Loopback, private, link-local, CGNAT, multicast, and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address.toLowerCase());
  return true; // not an address we can reason about — treat as unsafe
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0] = parts;

  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // 192.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(address: string): boolean {
  // ::ffff:127.0.0.1 and friends — judge the embedded IPv4 instead.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);

  if (address === "::" || address === "::1") return true;

  const head = address.split(":")[0] ?? "";
  const prefix = Number.parseInt(head.padStart(4, "0").slice(0, 2), 16);
  if (Number.isNaN(prefix)) return true;

  return (
    (prefix & 0xfe) === 0xfc || // fc00::/7 unique local
    (prefix === 0xfe && (Number.parseInt(head.padStart(4, "0")[2] ?? "0", 16) & 0xc) === 0x8) || // fe80::/10
    prefix === 0xff // multicast
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Read at most `maxBytes`. A `content-length` check alone is not enough — a
 * hostile or merely enormous response can stream forever without declaring one.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    truncated = size >= maxBytes;
  } finally {
    await reader.cancel().catch(() => {});
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(buffer.subarray(0, maxBytes)), truncated };
}
