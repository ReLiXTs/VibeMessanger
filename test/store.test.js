import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-store-"));
  return new Store(path.join(dir, "db.json"));
}

test("store: общая комната создаётся автоматически", () => {
  const s = tmpStore();
  const general = s.state.conversations.find((c) => c.name === "general");
  assert.ok(general);
  assert.equal(general.type, "room");
});

test("store: пользователи создаются и находятся без учёта регистра", () => {
  const s = tmpStore();
  const u = s.createUser({ username: "Alice", passwordHash: "h", salt: "s" });
  assert.equal(u.usernameLower, "alice");
  assert.ok(u.color);
  assert.equal(s.findUserByName("alice")?.id, u.id);
  assert.equal(s.findUserByName("ALICE")?.id, u.id);
  assert.equal(s.findUserByName("bob"), null);
});

test("store: личный чат уникален для пары", () => {
  const s = tmpStore();
  const a = s.createUser({ username: "a", passwordHash: "h", salt: "s" });
  const b = s.createUser({ username: "b", passwordHash: "h", salt: "s" });
  const d1 = s.createDm(a.id, b.id);
  const d2 = s.createDm(b.id, a.id);
  assert.equal(d1.id, d2.id);
  assert.equal(s.conversationsForUser(a.id).filter((c) => c.type === "dm").length, 1);
});

test("store: сообщения возвращаются в хронологическом порядке с лимитом", () => {
  const s = tmpStore();
  const u = s.createUser({ username: "u", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();
  for (let i = 0; i < 10; i++) s.addMessage({ conversationId: conv.id, userId: u.id, text: "m" + i });
  const last3 = s.messagesIn(conv.id, { limit: 3 });
  assert.equal(last3.length, 3);
  assert.deepEqual(last3.map((m) => m.text), ["m7", "m8", "m9"]);
  assert.equal(s.lastMessageIn(conv.id).text, "m9");
});

test("store: данные переживают перезагрузку", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-persist-"));
  const file = path.join(dir, "db.json");
  const s1 = new Store(file);
  const u = s1.createUser({ username: "persist", passwordHash: "h", salt: "s" });
  const conv = s1.ensureGeneral();
  s1.addMessage({ conversationId: conv.id, userId: u.id, text: "привет" });

  const s2 = new Store(file);
  assert.ok(s2.findUserByName("persist"));
  assert.equal(s2.messagesIn(conv.id).length, 1);
  assert.equal(s2.messagesIn(conv.id)[0].text, "привет");
});
