import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_STATE = () => ({
  users: [],
  conversations: [],
  messages: [],
  reads: [],
});

export function newId(prefix = "") {
  return prefix + crypto.randomBytes(9).toString("base64url");
}

const COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e",
  "#10b981", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6",
  "#d946ef", "#ec4899",
];

export function pickColor(seed = "") {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = DEFAULT_STATE();
    this._writing = false;
    this._pending = false;
    this.load();
  }

  load() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        this.state = {
          users: parsed.users ?? [],
          conversations: parsed.conversations ?? [],
          messages: parsed.messages ?? [],
          reads: parsed.reads ?? [],
        };
      } catch (err) {
        console.error("[store] не удалось прочитать файл, начинаю с пустой базы:", err.message);
        this.state = DEFAULT_STATE();
      }
    }
    this.ensureGeneral();
  }

  ensureGeneral() {
    let general = this.state.conversations.find(
      (c) => c.type === "room" && c.name.toLowerCase() === "general"
    );
    if (!general) {
      general = {
        id: "room-general",
        type: "room",
        name: "general",
        members: [],
        createdBy: null,
        createdAt: Date.now(),
      };
      this.state.conversations.push(general);
      this.persist();
    }
    return general;
  }

  persist() {
    if (!this.filePath) return;
    if (this._writing) {
      this._pending = true;
      return;
    }
    this._writing = true;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[store] ошибка записи:", err.message);
    } finally {
      this._writing = false;
      if (this._pending) {
        this._pending = false;
        this.persist();
      }
    }
  }

  // ---- users ----
  findUserByName(username) {
    const key = String(username ?? "").trim().toLowerCase();
    return this.state.users.find((u) => u.usernameLower === key) ?? null;
  }

  findUserById(id) {
    return this.state.users.find((u) => u.id === id) ?? null;
  }

  createUser({ username, passwordHash, salt }) {
    const user = {
      id: newId("u_"),
      username,
      usernameLower: username.trim().toLowerCase(),
      passwordHash,
      salt,
      color: pickColor(username),
      avatar: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.state.users.push(user);
    this.persist();
    return user;
  }

  updateUser(id, patch) {
    const u = this.findUserById(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.persist();
    return u;
  }

  touchUser(id) {
    const u = this.findUserById(id);
    if (u) {
      u.lastSeen = Date.now();
      this.persist();
    }
    return u;
  }

  // ---- conversations ----
  findConversation(id) {
    return this.state.conversations.find((c) => c.id === id) ?? null;
  }

  createRoom({ name, createdBy }) {
    const conv = {
      id: newId("r_"),
      type: "room",
      name,
      members: [],
      createdBy: createdBy ?? null,
      createdAt: Date.now(),
    };
    this.state.conversations.push(conv);
    this.persist();
    return conv;
  }

  dmKey(a, b) {
    return [a, b].sort().join(":");
  }

  findDm(a, b) {
    const key = this.dmKey(a, b);
    return this.state.conversations.find((c) => c.type === "dm" && c.dmKey === key) ?? null;
  }

  createDm(a, b) {
    const existing = this.findDm(a, b);
    if (existing) return existing;
    const conv = {
      id: newId("d_"),
      type: "dm",
      name: null,
      members: [a, b],
      dmKey: this.dmKey(a, b),
      createdBy: a,
      createdAt: Date.now(),
    };
    this.state.conversations.push(conv);
    this.persist();
    return conv;
  }

  conversationsForUser(userId) {
    return this.state.conversations.filter((c) => {
      if (c.type === "room") return true;
      return c.members.includes(userId);
    });
  }

  createGroup({ name, members, createdBy }) {
    const conv = {
      id: newId("g_"),
      type: "group",
      name,
      members: [...new Set([createdBy, ...members])],
      createdBy,
      createdAt: Date.now(),
    };
    this.state.conversations.push(conv);
    this.persist();
    return conv;
  }

  addMember(conversationId, userId) {
    const conv = this.findConversation(conversationId);
    if (!conv || conv.type === "dm") return null;
    if (!conv.members.includes(userId)) {
      conv.members.push(userId);
      this.persist();
    }
    return conv;
  }

  removeMember(conversationId, userId) {
    const conv = this.findConversation(conversationId);
    if (!conv || conv.type === "dm") return null;
    conv.members = conv.members.filter((m) => m !== userId);
    this.persist();
    return conv;
  }

  // ---- messages ----
  addMessage({ conversationId, userId, text, attachment = null, replyTo = null }) {
    const msg = {
      id: newId("m_"),
      conversationId,
      userId,
      text: text ?? "",
      attachment: attachment ?? null,
      replyTo: replyTo ?? null,
      reactions: {},
      editedAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    this.state.messages.push(msg);
    this.persist();
    return msg;
  }

  findMessage(id) {
    return this.state.messages.find((m) => m.id === id) ?? null;
  }

  updateMessage(id, text) {
    const msg = this.findMessage(id);
    if (!msg) return null;
    msg.text = text;
    msg.editedAt = Date.now();
    this.persist();
    return msg;
  }

  deleteMessage(id) {
    const msg = this.findMessage(id);
    if (!msg) return null;
    msg.deletedAt = Date.now();
    msg.text = "";
    msg.attachment = null;
    msg.reactions = {};
    this.persist();
    return msg;
  }

  toggleReaction(messageId, userId, emoji) {
    const msg = this.findMessage(messageId);
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    const list = msg.reactions[emoji] ?? [];
    const idx = list.indexOf(userId);
    if (idx === -1) list.push(userId);
    else list.splice(idx, 1);
    if (list.length === 0) delete msg.reactions[emoji];
    else msg.reactions[emoji] = list;
    this.persist();
    return msg;
  }

  messagesIn(conversationId, { limit = 50, before = null } = {}) {
    let list = this.state.messages.filter((m) => m.conversationId === conversationId);
    if (before) list = list.filter((m) => m.createdAt < before);
    list.sort((a, b) => a.createdAt - b.createdAt);
    return list.slice(-limit);
  }

  // ---- reads ----
  markRead(conversationId, userId, at = Date.now()) {
    let rec = this.state.reads.find(
      (r) => r.conversationId === conversationId && r.userId === userId
    );
    if (!rec) {
      rec = { conversationId, userId, lastReadAt: at };
      this.state.reads.push(rec);
    } else if (at > rec.lastReadAt) {
      rec.lastReadAt = at;
    }
    this.persist();
    return rec;
  }

  lastRead(conversationId, userId) {
    const rec = this.state.reads.find(
      (r) => r.conversationId === conversationId && r.userId === userId
    );
    return rec?.lastReadAt ?? 0;
  }

  unreadCount(conversationId, userId) {
    const since = this.lastRead(conversationId, userId);
    return this.state.messages.filter(
      (m) => m.conversationId === conversationId && m.userId !== userId && m.createdAt > since
    ).length;
  }

  lastMessageIn(conversationId) {
    let last = null;
    for (const m of this.state.messages) {
      if (m.conversationId !== conversationId) continue;
      if (!last || m.createdAt > last.createdAt) last = m;
    }
    return last;
  }
}

export default Store;
