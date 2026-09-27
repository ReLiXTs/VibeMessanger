import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { Server as SocketServer } from "socket.io";
import { Store, pickColor } from "./store.js";
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  validateCredentials,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOAD_DIR = path.join(__dirname, "..", "data", "uploads");

const MAX_MESSAGE_LEN = 4000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf|text\/plain|application\/zip|audio\/|video\/)/;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype || "")) return cb(null, true);
    cb(new Error("Недопустимый тип файла"));
  },
});

export function publicUser(u, onlineIds = null) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    color: u.color,
    avatar: u.avatar ?? null,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    online: onlineIds ? onlineIds.has(u.id) : undefined,
  };
}

function resolveSecret(explicit) {
  if (explicit) return explicit;
  if (process.env.MESSENGER_SECRET) return process.env.MESSENGER_SECRET;
  const dir = path.join(__dirname, "..", "data");
  const file = path.join(dir, "secret");
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
    fs.mkdirSync(dir, { recursive: true });
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString("hex");
  }
}

export function createServer(options = {}) {
  const secret = resolveSecret(options.secret);
  const store =
    options.store || new Store(options.dbPath ?? path.join(__dirname, "..", "data", "db.json"));

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  const online = new Map(); // userId -> Set(socketId)

  const isOnline = (userId) => (online.get(userId)?.size ?? 0) > 0;
  const onlineIds = () => new Set([...online.keys()].filter((id) => isOnline(id)));

  function authMiddleware(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return res.status(401).json({ error: "Не авторизован" });
    const user = store.findUserById(payload.uid);
    if (!user) return res.status(401).json({ error: "Пользователь не найден" });
    req.user = user;
    next();
  }

  function conversationForUser(convId, userId) {
    const conv = store.findConversation(convId);
    if (!conv) return null;
    if (conv.type === "room") return conv;
    if (!conv.members.includes(userId)) return null;
    return conv;
  }

  function convSummary(conv, viewerId) {
    const last = store.lastMessageIn(conv.id);
    const lastAuthor = last ? store.findUserById(last.userId) : null;
    return {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      members: conv.members,
      createdBy: conv.createdBy,
      createdAt: conv.createdAt,
      lastMessage: last ? serializeMessage(last) : null,
      unread: store.unreadCount(conv.id, viewerId),
      updatedAt: last ? last.createdAt : conv.createdAt,
    };
  }

  function serializeMessage(m) {
    const author = store.findUserById(m.userId);
    let reply = null;
    if (m.replyTo) {
      const parent = store.findMessage(m.replyTo);
      if (parent) {
        const pAuthor = store.findUserById(parent.userId);
        reply = {
          id: parent.id,
          text: parent.deletedAt ? "" : (parent.text || "").slice(0, 200),
          username: pAuthor?.username ?? null,
          deleted: Boolean(parent.deletedAt),
        };
      }
    }
    return {
      id: m.id,
      conversationId: m.conversationId,
      userId: m.userId,
      text: m.deletedAt ? "" : m.text,
      attachment: m.deletedAt ? null : m.attachment ?? null,
      reply,
      replyTo: m.replyTo ?? null,
      reactions: m.reactions ?? {},
      editedAt: m.editedAt ?? null,
      deletedAt: m.deletedAt ?? null,
      createdAt: m.createdAt,
      username: author?.username ?? "?",
      color: author?.color ?? "#888",
      avatar: author?.avatar ?? null,
    };
  }

  // ---------- REST ----------
  app.get("/api/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

  app.post("/api/register", (req, res) => {
    const { username, password } = req.body ?? {};
    const errors = validateCredentials(username, password);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    if (store.findUserByName(username)) {
      return res.status(409).json({ error: "Имя уже занято" });
    }
    const { salt, hash } = hashPassword(password);
    const user = store.createUser({ username: username.trim(), passwordHash: hash, salt });
    const token = createToken({ uid: user.id }, secret);
    res.status(201).json({ token, user: publicUser(user, onlineIds()) });
  });

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body ?? {};
    const user = store.findUserByName(username);
    if (!user || !verifyPassword(String(password ?? ""), user.salt, user.passwordHash)) {
      return res.status(401).json({ error: "Неверные имя или пароль" });
    }
    store.touchUser(user.id);
    const token = createToken({ uid: user.id }, secret);
    res.json({ token, user: publicUser(user, onlineIds()) });
  });

  app.get("/api/me", authMiddleware, (req, res) => {
    res.json({ user: publicUser(req.user, onlineIds()) });
  });

  app.patch("/api/me", authMiddleware, (req, res) => {
    const patch = {};
    if (typeof req.body?.username === "string") {
      const clean = req.body.username.trim();
      if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(clean)) {
        return res.status(400).json({ error: "Имя: 3-20 символов (буквы, цифры, _ . -)" });
      }
      const existing = store.findUserByName(clean);
      if (existing && existing.id !== req.user.id) {
        return res.status(409).json({ error: "Имя уже занято" });
      }
      patch.username = clean;
      patch.usernameLower = clean.toLowerCase();
      patch.color = pickColor(clean);
    }
    if (typeof req.body?.avatar === "string" || req.body?.avatar === null) {
      const av = req.body.avatar;
      if (av !== null && !/^\/api\/files\/[\w.-]+$/.test(av)) {
        return res.status(400).json({ error: "Некорректный аватар" });
      }
      patch.avatar = av;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Нечего обновлять" });
    store.updateUser(req.user.id, patch);
    const user = publicUser(req.user, onlineIds());
    io.emit("user:update", { user });
    res.json({ user });
  });

  app.get("/api/users", authMiddleware, (req, res) => {
    const ids = onlineIds();
    const users = store.state.users.map((u) => publicUser(u, ids));
    res.json({ users });
  });

  app.get("/api/conversations", authMiddleware, (req, res) => {
    const list = store
      .conversationsForUser(req.user.id)
      .map((c) => convSummary(c, req.user.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ conversations: list });
  });

  app.post("/api/conversations", authMiddleware, (req, res) => {
    const { type, name, userId } = req.body ?? {};
    if (type === "dm") {
      const other = store.findUserById(userId);
      if (!other || other.id === req.user.id) {
        return res.status(400).json({ error: "Некорректный собеседник" });
      }
      const conv = store.createDm(req.user.id, other.id);
      return res.status(201).json({ conversation: convSummary(conv, req.user.id) });
    }
    if (type === "room") {
      const clean = String(name ?? "").trim();
      if (clean.length < 2 || clean.length > 30) {
        return res.status(400).json({ error: "Название комнаты: 2-30 символов" });
      }
      if (store.state.conversations.some((c) => c.type === "room" && c.name.toLowerCase() === clean.toLowerCase())) {
        return res.status(409).json({ error: "Комната уже существует" });
      }
      const conv = store.createRoom({ name: clean, createdBy: req.user.id });
      const summary = convSummary(conv, req.user.id);
      for (const [, sockets] of io.sockets.sockets) {
        sockets.join(`conv:${conv.id}`);
      }
      io.emit("conversation:new", { conversation: summary });
      return res.status(201).json({ conversation: summary });
    }
    if (type === "group") {
      const clean = String(name ?? "").trim();
      if (clean.length < 2 || clean.length > 40) {
        return res.status(400).json({ error: "Название группы: 2-40 символов" });
      }
      const ids = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
      const valid = ids.filter((id) => id !== req.user.id && store.findUserById(id));
      if (valid.length < 1) {
        return res.status(400).json({ error: "Выберите хотя бы одного участника" });
      }
      const conv = store.createGroup({ name: clean, members: valid, createdBy: req.user.id });
      const summary = convSummary(conv, req.user.id);
      notifyConversation(conv, "Создана группа");
      return res.status(201).json({ conversation: summary });
    }
    res.status(400).json({ error: "Неизвестный тип" });
  });

  function notifyConversation(conv, label = "Новый чат") {
    for (const [, sockets] of io.sockets.sockets) {
      const uid = sockets.data.user?.id;
      if (conv.type === "room" || conv.members.includes(uid)) {
        sockets.join(`conv:${conv.id}`);
        sockets.emit("conversation:new", { conversation: convSummary(conv, uid), label });
      }
    }
  }

  app.post("/api/conversations/:id/members", authMiddleware, (req, res) => {
    const conv = conversationForUser(req.params.id, req.user.id);
    if (!conv || conv.type !== "group") return res.status(404).json({ error: "Группа не найдена" });
    if (conv.createdBy !== req.user.id) return res.status(403).json({ error: "Только создатель может добавлять" });
    const target = store.findUserById(req.body?.userId);
    if (!target) return res.status(400).json({ error: "Пользователь не найден" });
    store.addMember(conv.id, target.id);
    notifyConversation(conv, "Добавлен участник");
    res.json({ conversation: convSummary(conv, req.user.id) });
  });

  app.delete("/api/conversations/:id/members/:userId", authMiddleware, (req, res) => {
    const conv = conversationForUser(req.params.id, req.user.id);
    if (!conv || conv.type !== "group") return res.status(404).json({ error: "Группа не найдена" });
    const isSelf = req.params.userId === req.user.id;
    if (conv.createdBy !== req.user.id && !isSelf) {
      return res.status(403).json({ error: "Нет прав" });
    }
    store.removeMember(conv.id, req.params.userId);
    io.to(`conv:${conv.id}`).emit("conversation:update", { conversation: convSummary(conv, req.user.id) });
    res.json({ ok: true });
  });

  app.get("/api/conversations/:id/messages", authMiddleware, (req, res) => {
    const conv = conversationForUser(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = Number(req.query.before) || null;
    const messages = store.messagesIn(conv.id, { limit, before }).map(serializeMessage);
    res.json({ messages, conversation: convSummary(conv, req.user.id) });
  });

  function validateText(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return { error: "Пустое сообщение" };
    if (clean.length > MAX_MESSAGE_LEN) return { error: "Слишком длинное сообщение" };
    return { text: clean };
  }

  app.post("/api/conversations/:id/messages", authMiddleware, (req, res) => {
    const conv = conversationForUser(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    const { text, error } = validateText(req.body?.text);
    if (error) return res.status(400).json({ error });
    const replyTo = req.body?.replyTo ?? null;
    if (replyTo && !store.findMessage(replyTo)) {
      return res.status(400).json({ error: "Сообщение для ответа не найдено" });
    }
    const message = store.addMessage({ conversationId: conv.id, userId: req.user.id, text, replyTo });
    const payload = serializeMessage(message);
    io.to(`conv:${conv.id}`).emit("message:new", { message: payload });
    res.status(201).json({ message: payload });
  });

  app.patch("/api/messages/:id", authMiddleware, (req, res) => {
    const msg = store.findMessage(req.params.id);
    if (!msg || msg.userId !== req.user.id) {
      return res.status(404).json({ error: "Сообщение не найдено" });
    }
    const conv = conversationForUser(msg.conversationId, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    if (msg.deletedAt) return res.status(400).json({ error: "Сообщение удалено" });
    const { text, error } = validateText(req.body?.text);
    if (error) return res.status(400).json({ error });
    store.updateMessage(msg.id, text);
    const payload = serializeMessage(msg);
    io.to(`conv:${conv.id}`).emit("message:update", { message: payload });
    res.json({ message: payload });
  });

  app.delete("/api/messages/:id", authMiddleware, (req, res) => {
    const msg = store.findMessage(req.params.id);
    if (!msg) return res.status(404).json({ error: "Сообщение не найдено" });
    const conv = conversationForUser(msg.conversationId, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    const isOwner = msg.userId === req.user.id;
    const isRoomAdmin = conv.type === "room" && conv.createdBy === req.user.id;
    if (!isOwner && !isRoomAdmin) {
      return res.status(403).json({ error: "Нет прав на удаление" });
    }
    store.deleteMessage(msg.id);
    const payload = serializeMessage(msg);
    io.to(`conv:${conv.id}`).emit("message:delete", { message: payload });
    res.json({ message: payload });
  });

  app.post("/api/messages/:id/reactions", authMiddleware, (req, res) => {
    const emoji = String(req.body?.emoji ?? "");
    if (!emoji || emoji.length > 8) return res.status(400).json({ error: "Некорректная реакция" });
    const msg = store.findMessage(req.params.id);
    if (!msg) return res.status(404).json({ error: "Сообщение не найдено" });
    const conv = conversationForUser(msg.conversationId, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    store.toggleReaction(msg.id, req.user.id, emoji);
    const payload = serializeMessage(msg);
    io.to(`conv:${conv.id}`).emit("message:update", { message: payload });
    res.json({ message: payload });
  });

  app.post("/api/conversations/:id/read", authMiddleware, (req, res) => {
    const conv = conversationForUser(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: "Диалог не найден" });
    store.markRead(conv.id, req.user.id);
    res.json({ ok: true });
  });

  app.get("/api/files/:name", (req, res) => {
    const safe = path.basename(String(req.params.name));
    const file = path.join(UPLOAD_DIR, safe);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Файл не найден" });
    res.sendFile(file);
  });

  app.post("/api/upload", authMiddleware, (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? "Файл слишком большой (макс. 10 МБ)" : err.message;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: "Файл не передан" });
      const isImage = (req.file.mimetype || "").startsWith("image/");
      res.status(201).json({
        attachment: {
          url: `/api/files/${req.file.filename}`,
          name: req.file.originalname,
          size: req.file.size,
          mime: req.file.mimetype,
          isImage,
        },
      });
    });
  });

  // ---------- Static ----------
  app.use(express.static(PUBLIC_DIR));

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: "*" } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return next(new Error("unauthorized"));
    const user = store.findUserById(payload.uid);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  function broadcastPresence() {
    io.emit("presence:update", { online: [...onlineIds()] });
  }

  io.on("connection", (socket) => {
    const user = socket.data.user;
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    store.touchUser(user.id);

    for (const conv of store.conversationsForUser(user.id)) {
      socket.join(`conv:${conv.id}`);
    }
    socket.join(`user:${user.id}`);

    broadcastPresence();
    socket.emit("ready", { user: publicUser(user, onlineIds()) });

    socket.on("message:send", (data, ack) => {
      try {
        const conv = conversationForUser(data?.conversationId, user.id);
        if (!conv) return ack?.({ ok: false, error: "Диалог не найден" });
        const text = String(data?.text ?? "").trim();
        const attachment = data?.attachment ?? null;
        if (!text && !attachment) return ack?.({ ok: false, error: "Пустое сообщение" });
        if (text.length > MAX_MESSAGE_LEN) return ack?.({ ok: false, error: "Слишком длинное сообщение" });
        let replyTo = data?.replyTo ?? null;
        if (replyTo && !store.findMessage(replyTo)) replyTo = null;
        const message = store.addMessage({ conversationId: conv.id, userId: user.id, text, attachment, replyTo });
        const payload = { ...serializeMessage(message), clientId: data?.clientId ?? null };
        io.to(`conv:${conv.id}`).emit("message:new", { message: payload });
        ack?.({ ok: true, message: payload });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on("message:edit", (data, ack) => {
      const msg = store.findMessage(data?.messageId);
      if (!msg || msg.userId !== user.id) return ack?.({ ok: false, error: "Нет доступа" });
      const conv = conversationForUser(msg.conversationId, user.id);
      if (!conv) return ack?.({ ok: false, error: "Диалог не найден" });
      const text = String(data?.text ?? "").trim();
      if (!text) return ack?.({ ok: false, error: "Пустое сообщение" });
      if (text.length > MAX_MESSAGE_LEN) return ack?.({ ok: false, error: "Слишком длинное" });
      store.updateMessage(msg.id, text);
      const payload = serializeMessage(msg);
      io.to(`conv:${conv.id}`).emit("message:update", { message: payload });
      ack?.({ ok: true, message: payload });
    });

    socket.on("message:delete", (data, ack) => {
      const msg = store.findMessage(data?.messageId);
      if (!msg) return ack?.({ ok: false, error: "Сообщение не найдено" });
      const conv = conversationForUser(msg.conversationId, user.id);
      if (!conv) return ack?.({ ok: false, error: "Диалог не найден" });
      const isOwner = msg.userId === user.id;
      const isAdmin = conv.type === "room" && conv.createdBy === user.id;
      if (!isOwner && !isAdmin) return ack?.({ ok: false, error: "Нет прав" });
      store.deleteMessage(msg.id);
      const payload = serializeMessage(msg);
      io.to(`conv:${conv.id}`).emit("message:delete", { message: payload });
      ack?.({ ok: true, message: payload });
    });

    socket.on("message:react", (data, ack) => {
      const emoji = String(data?.emoji ?? "");
      if (!emoji || emoji.length > 8) return ack?.({ ok: false, error: "Некорректная реакция" });
      const msg = store.findMessage(data?.messageId);
      if (!msg) return ack?.({ ok: false, error: "Сообщение не найдено" });
      const conv = conversationForUser(msg.conversationId, user.id);
      if (!conv) return ack?.({ ok: false, error: "Диалог не найден" });
      store.toggleReaction(msg.id, user.id, emoji);
      const payload = serializeMessage(msg);
      io.to(`conv:${conv.id}`).emit("message:update", { message: payload });
      ack?.({ ok: true, message: payload });
    });

    socket.on("conversation:read", (data) => {
      const conv = conversationForUser(data?.conversationId, user.id);
      if (!conv) return;
      store.markRead(conv.id, user.id);
      socket.to(`conv:${conv.id}`).emit("read:update", {
        conversationId: conv.id,
        userId: user.id,
        lastReadAt: Date.now(),
      });
    });

    socket.on("typing", (data) => {
      const conv = conversationForUser(data?.conversationId, user.id);
      if (!conv) return;
      socket.to(`conv:${conv.id}`).emit("typing:update", {
        conversationId: conv.id,
        userId: user.id,
        username: user.username,
        typing: Boolean(data?.typing),
      });
    });

    socket.on("conversation:open", (data) => {
      const conv = conversationForUser(data?.conversationId, user.id);
      if (conv) socket.join(`conv:${conv.id}`);
    });

    socket.on("disconnect", () => {
      const set = online.get(user.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(user.id);
          store.touchUser(user.id);
        }
      }
      broadcastPresence();
    });
  });

  function start(port = 0) {
    return new Promise((resolve) => {
      httpServer.listen(port, () => resolve(httpServer.address().port));
    });
  }

  function stop() {
    return new Promise((resolve) => {
      io.close(() => httpServer.close(() => resolve()));
    });
  }

  return { app, httpServer, io, store, start, stop, secret };
}

// Автостарт при прямом запуске
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  const { start } = createServer();
  start(PORT).then((p) => {
    console.log(`VibeMessenger запущен: http://localhost:${p}`);
  });
}
