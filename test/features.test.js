import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-store2-"));
  return new Store(path.join(dir, "db.json"));
}

test("store: редактирование сообщения ставит editedAt", () => {
  const s = tmpStore();
  const u = s.createUser({ username: "u", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();
  const m = s.addMessage({ conversationId: conv.id, userId: u.id, text: "до" });
  assert.equal(m.editedAt, null);
  s.updateMessage(m.id, "после");
  assert.equal(m.text, "после");
  assert.ok(m.editedAt > 0);
});

test("store: удаление очищает текст и реакции, ставит deletedAt", () => {
  const s = tmpStore();
  const u = s.createUser({ username: "u", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();
  const m = s.addMessage({ conversationId: conv.id, userId: u.id, text: "текст", attachment: { url: "x" } });
  s.toggleReaction(m.id, u.id, "👍");
  s.deleteMessage(m.id);
  assert.equal(m.text, "");
  assert.equal(m.attachment, null);
  assert.deepEqual(m.reactions, {});
  assert.ok(m.deletedAt > 0);
});

test("store: реакции добавляются и снимаются", () => {
  const s = tmpStore();
  const a = s.createUser({ username: "a", passwordHash: "h", salt: "s" });
  const b = s.createUser({ username: "b", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();
  const m = s.addMessage({ conversationId: conv.id, userId: a.id, text: "hi" });

  s.toggleReaction(m.id, a.id, "❤️");
  s.toggleReaction(m.id, b.id, "❤️");
  assert.deepEqual(m.reactions["❤️"], [a.id, b.id]);

  s.toggleReaction(m.id, a.id, "❤️");
  assert.deepEqual(m.reactions["❤️"], [b.id]);

  s.toggleReaction(m.id, b.id, "❤️");
  assert.equal(m.reactions["❤️"], undefined);
});

test("store: непрочитанные считаются только от других", () => {
  const s = tmpStore();
  const a = s.createUser({ username: "a", passwordHash: "h", salt: "s" });
  const b = s.createUser({ username: "b", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();

  s.addMessage({ conversationId: conv.id, userId: a.id, text: "1" });
  s.addMessage({ conversationId: conv.id, userId: b.id, text: "2" });
  s.addMessage({ conversationId: conv.id, userId: a.id, text: "3" });

  assert.equal(s.unreadCount(conv.id, a.id), 1);
  assert.equal(s.unreadCount(conv.id, b.id), 2);

  s.markRead(conv.id, b.id);
  assert.equal(s.unreadCount(conv.id, b.id), 0);
});

test("store: ответ сохраняется ссылкой на родителя", () => {
  const s = tmpStore();
  const u = s.createUser({ username: "u", passwordHash: "h", salt: "s" });
  const conv = s.ensureGeneral();
  const parent = s.addMessage({ conversationId: conv.id, userId: u.id, text: "родитель" });
  const reply = s.addMessage({ conversationId: conv.id, userId: u.id, text: "ответ", replyTo: parent.id });
  assert.equal(reply.replyTo, parent.id);
  assert.equal(s.findMessage(reply.replyTo).text, "родитель");
});
