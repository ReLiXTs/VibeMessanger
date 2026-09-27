import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/ratelimit.js";

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

test("ratelimit: пропускает в пределах лимита", () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 3 });
  const req = { ip: "1.1.1.1" };
  let passed = 0;
  for (let i = 0; i < 3; i++) {
    rl(req, fakeRes(), () => passed++);
  }
  assert.equal(passed, 3);
});

test("ratelimit: блокирует после лимита с 429", () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 2 });
  const req = { ip: "2.2.2.2" };
  rl(req, fakeRes(), () => {});
  rl(req, fakeRes(), () => {});
  const res = fakeRes();
  let passed = false;
  rl(req, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.includes("Слишком много"), true);
  assert.ok(res.headers["Retry-After"] >= 1);
});

test("ratelimit: ключи (IP) независимы", () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 1 });
  rl({ ip: "a" }, fakeRes(), () => {});
  let bPassed = false;
  rl({ ip: "b" }, fakeRes(), () => { bPassed = true; });
  assert.equal(bPassed, true);
});

test("ratelimit: окно сбрасывается со временем", async () => {
  const rl = createRateLimiter({ windowMs: 40, max: 1 });
  const req = { ip: "c" };
  rl(req, fakeRes(), () => {});
  await new Promise((r) => setTimeout(r, 60));
  let passed = false;
  rl(req, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
});
