import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  validateCredentials,
} from "../src/auth.js";

test("auth: пароль хэшируется и проверяется", () => {
  const { salt, hash } = hashPassword("secret123");
  assert.ok(salt.length > 0);
  assert.ok(verifyPassword("secret123", salt, hash));
  assert.equal(verifyPassword("wrong", salt, hash), false);
});

test("auth: одинаковые пароли дают разные хэши (соль)", () => {
  const a = hashPassword("same");
  const b = hashPassword("same");
  assert.notEqual(a.hash, b.hash);
});

test("auth: токен подписывается и проверяется", () => {
  const secret = "test-secret";
  const token = createToken({ uid: "u_1" }, secret);
  const payload = verifyToken(token, secret);
  assert.equal(payload.uid, "u_1");
  assert.ok(payload.exp > Date.now());
});

test("auth: подделанный токен отклоняется", () => {
  const token = createToken({ uid: "u_1" }, "secret-a");
  assert.equal(verifyToken(token, "secret-b"), null);
  assert.equal(verifyToken("garbage", "secret-a"), null);
  assert.equal(verifyToken(null, "secret-a"), null);
});

test("auth: истёкший токен отклоняется", () => {
  const secret = "s";
  const token = createToken({ uid: "u" }, secret, -1000);
  assert.equal(verifyToken(token, secret), null);
});

test("auth: валидация учётных данных", () => {
  assert.equal(validateCredentials("bob", "123456").length, 0);
  assert.ok(validateCredentials("bo", "123456").length > 0);
  assert.ok(validateCredentials("bad name", "123456").length > 0);
  assert.ok(validateCredentials("bob", "123").length > 0);
});
