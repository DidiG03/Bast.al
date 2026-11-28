// Players never see database or driver text: the error filter answers with a
// friendly message (503 when the database is out of room or unreachable, 500
// otherwise) and a reference, whatever NODE_ENV is. Our own errors keep their
// wording.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const { BadRequestException, ServiceUnavailableException, Logger } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SanitizedExceptionFilter, isDatabaseUnavailable, FRIENDLY_ERROR, BUSY_ERROR } = require("../dist/security/sanitized-exception.filter.js");

Logger.overrideLogger(false);

function answer(exception, nodeEnv) {
  const before = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const sent = {};
  const response = { headersSent: false, status(code) { sent.status = code; return this; }, json(body) { sent.body = body; } };
  const request = { method: "GET", url: "/odds/events?filter=upcoming", headers: {} };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) };
  try {
    new SanitizedExceptionFilter().catch(exception, host);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
  return sent;
}

// The error production showed players, as Prisma raises it.
const diskFull = new Prisma.PrismaClientKnownRequestError(
  'Invalid `prisma.$queryRaw()` invocation:\n\nRaw query failed. Code: `53100`. Message: `could not write to file "base/pgsql_tmp/pgsql_tmp123.4": No space left on device`',
  { code: "P2010", clientVersion: "5.20.0", meta: { code: "53100", message: 'could not write to file "base/pgsql_tmp/pgsql_tmp123.4": No space left on device' } },
);

test("a full database disk is a 503 with a friendly message, even with NODE_ENV unset", () => {
  for (const env of [undefined, "production", "staging"]) {
    const { status, body } = answer(diskFull, env);
    assert.equal(status, 503);
    assert.equal(body.message, BUSY_ERROR);
    assert.ok(body.requestId, "a reference to quote");
    assert.doesNotMatch(JSON.stringify(body), /prisma|queryRaw|53100|pgsql_tmp|No space/i);
  }
});

test("other database and program errors are a 500 with a friendly message", () => {
  const constraint = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`username`)", { code: "P2002", clientVersion: "5.20.0" });
  for (const error of [constraint, new TypeError("Cannot read properties of undefined (reading 'id')")]) {
    const { status, body } = answer(error, undefined);
    assert.equal(status, 500);
    assert.equal(body.message, FRIENDLY_ERROR);
  }
});

test("our own errors keep their wording", () => {
  assert.deepEqual(answer(new BadRequestException("Stake must be at least 50 ALL"), undefined).body.message, "Stake must be at least 50 ALL");
  const busy = answer(new ServiceUnavailableException("Couldn't check your password with Clerk. Try again in a minute."), "production");
  assert.equal(busy.status, 503);
  assert.equal(busy.body.message, "Couldn't check your password with Clerk. Try again in a minute.");
});

test("only local development sees the real message", () => {
  assert.match(answer(new TypeError("boom"), "development").body.message, /boom/);
});

test("which database errors pass", () => {
  assert.equal(isDatabaseUnavailable(diskFull), true);
  assert.equal(isDatabaseUnavailable(new Prisma.PrismaClientKnownRequestError("Timed out fetching a new connection from the connection pool", { code: "P2024", clientVersion: "5.20.0" })), true);
  assert.equal(isDatabaseUnavailable(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.20.0" })), false);
  assert.equal(isDatabaseUnavailable(new Error("No space left on device")), false, "only Prisma's errors are read this way");
});
