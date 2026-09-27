import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io as ioClient } from "socket.io-client";
import { createServer } from "../src/server.js";

let server;
let base;
let alice;
let bob;

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-api-"));
  server = createServer({ dbPath: path.join(dir, "db.json"), secret: "test-secret" });
  const port = await server.start(0);
  base = `http://localhost:${port}`;

  const reg = async (username, password) => {
    const res = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  alice = await reg("alice", "password1");
  bob = await reg("bob", "password1");
});

after(async () => {
  await server.stop();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test("api: регистрация отклоняет занятое имя", async () => {
  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "password1" }),
  });
  assert.equal(res.status, 409);
});

test("api: вход с неверным паролем", async () => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "nope" }),
  });
  assert.equal(res.status, 401);
});

test("api: защищённые маршруты требуют токен", async () => {
  const res = await fetch(`${base}/api/conversations`);
  assert.equal(res.status, 401);
});

test("api: /api/me возвращает пользователя", async () => {
  const res = await fetch(`${base}/api/me`, { headers: auth(alice.token) });
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.username, "alice");
});

test("api: создание личного чата и отправка сообщения через REST", async () => {
  const convRes = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ type: "dm", userId: bob.user.id }),
  });
  assert.equal(convRes.status, 201);
  const { conversation } = await convRes.json();
  assert.equal(conversation.type, "dm");

  const msgRes = await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "привет, боб" }),
  });
  assert.equal(msgRes.status, 201);

  const listRes = await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
    headers: auth(bob.token),
  });
  const { messages } = await listRes.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "привет, боб");
  assert.equal(messages[0].username, "alice");
});

test("api: посторонний не читает чужой личный чат", async () => {
  const reg = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "eve", password: "password1" }),
  });
  const eve = await reg.json();
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const res = await fetch(`${base}/api/conversations/${dm.id}/messages`, { headers: auth(eve.token) });
  assert.equal(res.status, 404);
});

test("api: пустое сообщение отклоняется", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const res = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(res.status, 400);
});

test("socket: обмен сообщениями в реальном времени", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);

  const s1 = ioClient(base, { auth: { token: alice.token }, transports: ["websocket"] });
  const s2 = ioClient(base, { auth: { token: bob.token }, transports: ["websocket"] });
  await Promise.all([waitFor(s1, "ready"), waitFor(s2, "ready")]);

  const received = waitFor(s2, "message:new");
  const ack = await new Promise((resolve) =>
    s1.emit("message:send", { conversationId: dm.id, text: "realtime!" }, resolve)
  );
  assert.equal(ack.ok, true);

  const payload = await received;
  assert.equal(payload.message.text, "realtime!");
  assert.equal(payload.message.username, "alice");

  s1.close();
  s2.close();
});

test("socket: без токена подключение отклоняется", async () => {
  const s = ioClient(base, { auth: {}, transports: ["websocket"] });
  const err = await waitFor(s, "connect_error");
  assert.match(err.message, /unauthorized/);
  s.close();
});

test("socket: рассылка о новой комнате", async () => {
  const s1 = ioClient(base, { auth: { token: alice.token }, transports: ["websocket"] });
  await waitFor(s1, "ready");
  const newConv = waitFor(s1, "conversation:new");

  const res = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ type: "room", name: "random" }),
  });
  assert.equal(res.status, 201);
  const payload = await newConv;
  assert.equal(payload.conversation.name, "random");
  s1.close();
});

test("api: дубликат комнаты отклоняется", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ type: "room", name: "random" }),
  });
  assert.equal(res.status, 409);
});

test("api: редактирование своего сообщения и запрет чужого", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const created = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "редактируй меня" }),
  });
  const { message } = await created.json();

  const edit = await fetch(`${base}/api/messages/${message.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "изменено" }),
  });
  assert.equal(edit.status, 200);
  const edited = await edit.json();
  assert.equal(edited.message.text, "изменено");
  assert.ok(edited.message.editedAt);

  const forbidden = await fetch(`${base}/api/messages/${message.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ text: "взлом" }),
  });
  assert.equal(forbidden.status, 404);
});

test("api: удаление сообщения и запрет чужого", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const created = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ text: "удали меня" }),
  });
  const { message } = await created.json();

  const forbidden = await fetch(`${base}/api/messages/${message.id}`, {
    method: "DELETE",
    headers: auth(alice.token),
  });
  assert.equal(forbidden.status, 403);

  const del = await fetch(`${base}/api/messages/${message.id}`, {
    method: "DELETE",
    headers: auth(bob.token),
  });
  assert.equal(del.status, 200);
  const deleted = await del.json();
  assert.ok(deleted.message.deletedAt);
  assert.equal(deleted.message.text, "");
});

test("api: реакции переключаются", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const created = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "реакция" }),
  });
  const { message } = await created.json();

  const r1 = await fetch(`${base}/api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ emoji: "🔥" }),
  });
  const one = await r1.json();
  assert.deepEqual(one.message.reactions["🔥"], [bob.user.id]);

  const r2 = await fetch(`${base}/api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ emoji: "🔥" }),
  });
  const two = await r2.json();
  assert.equal(two.message.reactions["🔥"], undefined);
});

test("api: счётчик непрочитанных через summary", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  await fetch(`${base}/api/conversations/${dm.id}/read`, {
    method: "POST",
    headers: auth(bob.token),
  });
  await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "непрочитанное" }),
  });
  const res = await fetch(`${base}/api/conversations`, { headers: auth(bob.token) });
  const { conversations } = await res.json();
  const summary = conversations.find((c) => c.id === dm.id);
  assert.ok(summary.unread >= 1);
});

test("api: ответ содержит вложенный reply", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const parentRes = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ text: "родительское" }),
  });
  const parent = (await parentRes.json()).message;

  const replyRes = await fetch(`${base}/api/conversations/${dm.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ text: "ответ", replyTo: parent.id }),
  });
  const reply = (await replyRes.json()).message;
  assert.equal(reply.replyTo, parent.id);
  assert.equal(reply.reply.text, "родительское");
  assert.equal(reply.reply.username, "alice");
});

test("socket: редактирование и удаление рассылаются", async () => {
  const dm = server.store.findDm(alice.user.id, bob.user.id);
  const s1 = ioClient(base, { auth: { token: alice.token }, transports: ["websocket"] });
  const s2 = ioClient(base, { auth: { token: bob.token }, transports: ["websocket"] });
  await Promise.all([waitFor(s1, "ready"), waitFor(s2, "ready")]);

  const up = waitFor(s2, "message:update");
  const ack = await new Promise((r) =>
    s1.emit("message:send", { conversationId: dm.id, text: "правь" }, r)
  );
  const msgId = ack.message.id;

  const editAck = await new Promise((r) =>
    s1.emit("message:edit", { messageId: msgId, text: "исправлено" }, r)
  );
  assert.equal(editAck.ok, true);
  const upd = await up;
  assert.equal(upd.message.text, "исправлено");

  const delEvent = waitFor(s2, "message:delete");
  const delAck = await new Promise((r) => s1.emit("message:delete", { messageId: msgId }, r));
  assert.equal(delAck.ok, true);
  const deld = await delEvent;
  assert.ok(deld.message.deletedAt);

  s1.close();
  s2.close();
});

test("api: загрузка файла и запрет опасного типа", async () => {
  const form = new FormData();
  form.append("file", new Blob(["hello file"], { type: "text/plain" }), "note.txt");
  const res = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: auth(alice.token),
    body: form,
  });
  assert.equal(res.status, 201);
  const { attachment } = await res.json();
  assert.ok(attachment.url.startsWith("/api/files/"));
  assert.equal(attachment.isImage, false);

  const fetched = await fetch(`${base}${attachment.url}`);
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), "hello file");

  const bad = new FormData();
  bad.append("file", new Blob(["x"], { type: "application/x-msdownload" }), "evil.exe");
  const badRes = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: auth(alice.token),
    body: bad,
  });
  assert.equal(badRes.status, 400);
});

test("api: загрузка требует авторизацию", async () => {
  const form = new FormData();
  form.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
  const res = await fetch(`${base}/api/upload`, { method: "POST", body: form });
  assert.equal(res.status, 401);
});

test("api: обновление профиля — имя и аватар", async () => {
  const res = await fetch(`${base}/api/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ username: "alice_renamed" }),
  });
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.username, "alice_renamed");
  alice.user = user;

  const dup = await fetch(`${base}/api/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ username: "alice_renamed" }),
  });
  assert.equal(dup.status, 409);

  const badAvatar = await fetch(`${base}/api/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ avatar: "http://evil.example/x.png" }),
  });
  assert.equal(badAvatar.status, 400);
});

test("api: создание группы и доступ участников", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ type: "group", name: "Команда", memberIds: [bob.user.id] }),
  });
  assert.equal(res.status, 201);
  const { conversation } = await res.json();
  assert.equal(conversation.type, "group");
  assert.ok(conversation.members.includes(alice.user.id));
  assert.ok(conversation.members.includes(bob.user.id));

  const msg = await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(bob.token) },
    body: JSON.stringify({ text: "всем привет" }),
  });
  assert.equal(msg.status, 201);
});

test("api: группа требует участника", async () => {
  const res = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ type: "group", name: "Пустая", memberIds: [] }),
  });
  assert.equal(res.status, 400);
});

test("api: посторонний не видит группу", async () => {
  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "stranger", password: "password1" }),
  });
  const stranger = await res.json();
  const group = server.store.state.conversations.find((c) => c.type === "group");
  const read = await fetch(`${base}/api/conversations/${group.id}/messages`, {
    headers: auth(stranger.token),
  });
  assert.equal(read.status, 404);
});

test("api: добавление и выход из группы", async () => {
  const res = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "newbie", password: "password1" }),
  });
  const newbie = await res.json();
  const group = server.store.state.conversations.find((c) => c.type === "group");

  const add = await fetch(`${base}/api/conversations/${group.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(alice.token) },
    body: JSON.stringify({ userId: newbie.user.id }),
  });
  assert.equal(add.status, 200);
  assert.ok(server.store.findConversation(group.id).members.includes(newbie.user.id));

  const leave = await fetch(`${base}/api/conversations/${group.id}/members/${newbie.user.id}`, {
    method: "DELETE",
    headers: auth(newbie.token),
  });
  assert.equal(leave.status, 200);
  assert.ok(!server.store.findConversation(group.id).members.includes(newbie.user.id));
});
