import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { requireAdmin, requireAuth, type AuthedRequest } from "../src/middleware/auth.middleware.js";
import { hashPassword, signToken, verifyPassword } from "../src/services/auth.service.js";

const previousSecret = process.env["JWT_SECRET"];

before(() => {
  process.env["JWT_SECRET"] = "test-secret";
});

after(() => {
  if (previousSecret === undefined) delete process.env["JWT_SECRET"];
  else process.env["JWT_SECRET"] = previousSecret;
});

test("hashPassword produces a salt:hash pair that verifyPassword accepts", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
});

test("verifyPassword rejects the wrong password", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("two hashes of the same password are salted differently", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a, b);
});

test("signToken produces a JWT carrying sub, email, and role", () => {
  const token = signToken({ sub: "user-1", email: "user@example.com", role: "user" });
  const payload = jwt.verify(token, "test-secret") as { sub: string; email: string; role: string };
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.email, "user@example.com");
  assert.equal(payload.role, "user");
});

/** Minimal stand-ins — enough surface for requireAuth without pulling in Express. */
function fakeReq(header?: string) {
  return { header: () => header } as unknown as Parameters<typeof requireAuth>[0];
}

function fakeRes() {
  const state = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as Parameters<typeof requireAuth>[1], state };
}

test("requireAuth rejects a missing bearer token", () => {
  const { res, state } = fakeRes();
  let nextCalled = false;
  requireAuth(fakeReq(undefined), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.status, 401);
});

test("requireAuth rejects a malformed or invalid token", () => {
  const { res, state } = fakeRes();
  let nextCalled = false;
  requireAuth(fakeReq("Bearer not-a-real-token"), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.status, 401);
});

test("requireAuth attaches userId, userEmail, and userRole from a valid token, then calls next", () => {
  const token = signToken({ sub: "user-42", email: "person@example.com", role: "admin" });
  const req = fakeReq(`Bearer ${token}`);
  const { res } = fakeRes();
  let nextCalled = false;

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  const authed = req as unknown as AuthedRequest;
  assert.equal(authed.userId, "user-42");
  assert.equal(authed.userEmail, "person@example.com");
  assert.equal(authed.userRole, "admin");
});

function fakeAuthedReq(role: "user" | "admin") {
  return { userRole: role } as unknown as Parameters<typeof requireAdmin>[0];
}

test("requireAdmin rejects a plain user", () => {
  const { res, state } = fakeRes();
  let nextCalled = false;
  requireAdmin(fakeAuthedReq("user"), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.status, 403);
});

test("requireAdmin calls next for an admin", () => {
  const { res } = fakeRes();
  let nextCalled = false;
  requireAdmin(fakeAuthedReq("admin"), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
