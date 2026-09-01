import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicUrl, isPrivateAddress } from "../src/http.js";

/**
 * These are the security tests for the package. Every URL reaching this guard
 * came from model output or from a search result, and the agent runs inside our
 * network — an unguarded fetch is an SSRF primitive pointed at our own Postgres
 * and at the cloud metadata endpoint.
 */

test("only http and https are allowed", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /http/);
  await assert.rejects(() => assertPublicUrl("ftp://example.com/x"), /http/);
  await assert.rejects(() => assertPublicUrl("not a url"), /not a valid URL/);
});

test("loopback and private hosts are refused", async () => {
  for (const url of [
    "http://localhost:5433/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://printer.local/",
    "http://db.internal/",
  ]) {
    await assert.rejects(() => assertPublicUrl(url), /private address/, url);
  }
});

test("the cloud metadata endpoint is refused", async () => {
  await assert.rejects(
    () => assertPublicUrl("http://169.254.169.254/latest/meta-data/"),
    /private address/,
  );
});

test("a public URL passes through normalized", async () => {
  assert.equal(await assertPublicUrl("https://example.com/page"), "https://example.com/page");
});

test("the private check can be opted out of for a self-hosted backend", async () => {
  assert.equal(await assertPublicUrl("http://localhost:8080/search", true), "http://localhost:8080/search");
});

test("address classification covers the ranges we care about", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, `should be private: ${address}`);
  }

  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `should be public: ${address}`);
  }
});
