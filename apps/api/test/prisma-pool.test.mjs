// Run with `npm test --workspace apps/api` (builds first). The API's database
// pool: 20 connections unless DATABASE_URL sets its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPoolSize } from "../dist/prisma.service.js";

test("a URL without a pool size gets 20 connections, keeping what else it says", () => {
  const url = new URL(withPoolSize("postgresql://u:p@db:5432/bastal?schema=public", 20));
  assert.equal(url.searchParams.get("connection_limit"), "20");
  assert.equal(url.searchParams.get("schema"), "public");
  assert.equal(url.password, "p");
});

test("a pool size set in DATABASE_URL is kept", () => {
  const url = "postgresql://u:p@db:5432/bastal?connection_limit=7";
  assert.equal(withPoolSize(url, 20), url);
});

test("no DATABASE_URL stays none, so Prisma still says it's missing", () => {
  assert.equal(withPoolSize(undefined, 20), undefined);
});
