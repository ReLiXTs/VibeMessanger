/* VibeMessenger — клиент */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const QUICK_EMOJI = ["👍", "❤️", "😂", "🔥", "😮", "😢"];
  const state = {
    token: localStorage.getItem("messenger.token") || null,
    me: null,
    users: new Map(),
    conversations: [],
    currentId: null,
    messages: new Map(),
    online: new Set(),
    typingTimers: new Map(),
    socket: null,
    authMode: "login",
    replyTo: null,
    attachment: null,
    editingId: null,
  };

  // ---------- helpers ----------
  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Сегодня";
    if (d.toDateString() === y.toDateString()) return "Вчера";
    return d.toLocaleDateString("ru-RU");
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / 1048576).toFixed(1) + " МБ";
  }
  function esc(s) {
    const div = document.createElement("div");
    div.textContent = s ?? "";
    return div.innerHTML;
  }
  function avatarEl(user, cls = "avatar") {
    const el = document.createElement("span");
    el.className = cls;
    if (user?.avatar) {
      el.style.backgroundImage = `url("${user.avatar}")`;
      el.classList.add("has-img");
    } else {
      el.style.background = user?.color || "#555";
      el.textContent = initials(user?.username);
    }
    return el;
  }
  function updateAvatarEl(el, user) {
    el.className = "avatar";
    el.style.backgroundImage = "";
    el.style.background = "";
    if (user?.avatar) {
      el.style.backgroundImage = `url("${user.avatar}")`;
      el.classList.add("has-img");
      el.textContent = "";
    } else {
      el.style.background = user?.color || "#555";
      el.textContent = initials(user?.username);
    }
  }

  // ---------- notifications ----------
  let notifyAudio = null;
  function playPing() {
    try {
      if (!notifyAudio) notifyAudio = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=");
      notifyAudio.currentTime = 0;
      notifyAudio.volume = 0.25;
      notifyAudio.play().catch(() => {});
    } catch {}
  }
  function notify(title, body) {
    playPing();
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted" && document.hidden) {
      const n = new Notification(title, { body, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
  function requestNotifyPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add("hidden"), 2800);
  }

  const baseTitle = "VibeMessenger";
  function updateTitleBadge() {
    const total = state.conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
    document.title = total > 0 ? `(${total}) ${baseTitle}` : baseTitle;
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- auth ----------
  $("#tab-login").onclick = () => setAuthMode("login");
  $("#tab-register").onclick = () => setAuthMode("register");
  function setAuthMode(mode) {
    state.authMode = mode;
    $("#tab-login").classList.toggle("active", mode === "login");
    $("#tab-register").classList.toggle("active", mode === "register");
    $("#auth-submit").textContent = mode === "login" ? "Войти" : "Создать аккаунт";
    $("#auth-error").textContent = "";
  }

  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const username = $("#username").value.trim();
    const password = $("#password").value;
    const btn = $("#auth-submit");
    btn.disabled = true;
    $("#auth-error").textContent = "";
    try {
      const path = state.authMode === "login" ? "/api/login" : "/api/register";
      const data = await api(path, { method: "POST", body: JSON.stringify({ username, password }) });
      state.token = data.token;
      localStorage.setItem("messenger.token", data.token);
      state.me = data.user;
      await enterApp();
    } catch (err) {
      $("#auth-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };

  $("#logout").onclick = () => {
    state.socket?.disconnect();
    localStorage.removeItem("messenger.token");
    location.reload();
  };

  // ---------- app ----------
  async function enterApp() {
    $("#auth").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderMe();
    requestNotifyPermission();
    await Promise.all([loadUsers(), loadConversations()]);
    connectSocket();
  }

  function renderMe() {
    const old = $("#me-avatar");
    updateAvatarEl(old, state.me);
    old.id = "me-avatar";
    $("#me-name").textContent = state.me.username;
  }

  async function loadUsers() {
    const { users } = await api("/api/users");
    state.users = new Map(users.map((u) => [u.id, u]));
    renderOnline();
  }

  async function loadConversations() {
    const { conversations } = await api("/api/conversations");
    state.conversations = conversations;
    renderConversations();
  }

  function otherMember(conv) {
    if (conv.type === "group") {
      return { id: conv.id, username: conv.name, color: "#8b5cf6", isGroup: true, members: conv.members };
    }
    const id = conv.members.find((m) => m !== state.me.id);
    return state.users.get(id) || { id, username: "Пользователь", color: "#555" };
  }
  function convTitle(conv) {
    if (conv.type === "room") return `# ${conv.name}`;
    if (conv.type === "group") return `👥 ${conv.name}`;
    return otherMember(conv).username;
  }

  function renderConversations() {
    const q = $("#search").value.trim().toLowerCase();
    const box = $("#conversations");
    box.innerHTML = "";
    const list = state.conversations.filter((c) => convTitle(c).toLowerCase().includes(q));
    if (!list.length) {
      box.innerHTML = `<div class="empty-state small" style="margin:20px">Ничего не найдено</div>`;
      return;
    }
    for (const conv of list) {
      const el = document.createElement("div");
      el.className = "conv" + (conv.id === state.currentId ? " active" : "");
      el.dataset.id = conv.id;

      const title = conv.type === "dm" ? otherMember(conv) : { username: conv.name, color: "#5b8def" };
      el.appendChild(avatarEl(title));
      const body = document.createElement("div");
      body.className = "conv-body";
      const last = conv.lastMessage;
      const unread = conv.unread || 0;
      const lastText = last
        ? last.deletedAt
          ? "сообщение удалено"
          : (last.attachment && !last.text ? "📎 вложение" : last.text)
        : "нет сообщений";
      body.innerHTML = `
        <div class="conv-top">
          <span class="conv-name">${esc(convTitle(conv))}</span>
          <span class="conv-time">${last ? fmtTime(last.createdAt) : ""}</span>
        </div>
        <div class="conv-top">
          <span class="conv-last">${last ? esc((last.username ? last.username + ": " : "") + lastText) : lastText}</span>
          ${unread ? `<span class="badge">${unread}</span>` : ""}
        </div>`;
      el.appendChild(body);
      el.onclick = () => openConversation(conv.id);
      box.appendChild(el);
    }
    updateTitleBadge();
  }

  async function openConversation(id) {
    state.currentId = id;
    state.replyTo = null;
    state.attachment = null;
    state.editingId = null;
    renderReplyBar();
    renderAttachPreview();
    state.socket?.emit("conversation:open", { conversationId: id });
    state.socket?.emit("conversation:read", { conversationId: id });
    const conv = state.conversations.find((c) => c.id === id);
    if (conv) {
      conv.unread = 0;
      $("#chat-title").textContent = convTitle(conv);
      updateChatSub(conv);
    }
    $("#composer").classList.remove("hidden");
    renderConversations();
    await loadMessages(id);
    $("#input").focus();
  }

  function updateChatSub(conv) {
    if (conv.type === "dm") {
      const u = otherMember(conv);
      $("#chat-sub").textContent = state.online.has(u.id) ? "в сети" : "не в сети";
    } else if (conv.type === "group") {
      const others = conv.members.filter((m) => m !== state.me.id);
      const online = others.filter((m) => state.online.has(m)).length;
      $("#chat-sub").textContent = `${others.length} участник(ов) · ${online} в сети`;
    } else {
      $("#chat-sub").textContent = "публичная комната";
    }
  }

  async function loadMessages(id) {
    const { messages } = await api(`/api/conversations/${id}/messages?limit=100`);
    state.messages.set(id, messages);
    renderMessages();
  }

  function renderMessages() {
    const box = $("#messages");
    const list = state.messages.get(state.currentId) || [];
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<div class="empty-state">Сообщений пока нет. Напишите первым!</div>`;
      return;
    }
    let lastDay = null;
    for (const m of list) {
      const day = fmtDay(m.createdAt);
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement("div");
        sep.className = "empty-state small";
        sep.style.margin = "6px 0";
        sep.textContent = day;
        box.appendChild(sep);
      }
      box.appendChild(messageEl(m));
    }
    box.scrollTop = box.scrollHeight;
  }

  function messageEl(m) {
    const out = m.userId === state.me.id;
    const row = document.createElement("div");
    row.className = "msg" + (out ? " out" : "") + (m.deletedAt ? " deleted" : "");
    row.dataset.id = m.id;
    row.appendChild(avatarEl({ username: m.username, color: m.color, avatar: m.avatar }));

    const body = document.createElement("div");
    body.className = "msg-body";

    if (m.reply) {
      const quote = document.createElement("div");
      quote.className = "reply-quote";
      quote.innerHTML = `<b>${esc(m.reply.username)}</b>: ${m.reply.deleted ? "(удалено)" : esc(m.reply.text)}`;
      body.appendChild(quote);
    }

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.innerHTML = `${esc(m.username)}<span class="edited">${m.editedAt ? " (изменено)" : ""}</span>`;
    body.appendChild(meta);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.deletedAt ? "Сообщение удалено" : m.text;
    body.appendChild(bubble);

    if (m.attachment && !m.deletedAt) {
      const att = document.createElement("div");
      att.className = "msg-attachment";
      if (m.attachment.isImage) {
        const img = document.createElement("img");
        img.src = m.attachment.url;
        img.alt = m.attachment.name;
        img.onclick = () => openLightbox(m.attachment.url);
        att.appendChild(img);
      } else {
        const a = document.createElement("a");
        a.href = m.attachment.url;
        a.download = m.attachment.name;
        a.innerHTML = `📄 ${esc(m.attachment.name)} <span class="muted small">(${fmtSize(m.attachment.size)})</span>`;
        att.appendChild(a);
      }
      body.appendChild(att);
    }

    if (m.reactions && Object.keys(m.reactions).length) {
      const rx = document.createElement("div");
      rx.className = "reactions";
      for (const [emoji, users] of Object.entries(m.reactions)) {
        const b = document.createElement("button");
        b.className = "reaction" + (users.includes(state.me.id) ? " mine" : "");
        b.textContent = `${emoji} ${users.length}`;
        b.title = "Поставить/убрать реакцию";
        b.onclick = () => react(m.id, emoji);
        rx.appendChild(b);
      }
      body.appendChild(rx);
    }

    row.appendChild(body);

    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = fmtTime(m.createdAt);
    row.appendChild(time);

    if (!m.deletedAt) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.appendChild(actionBtn("🙂", "Реакция", () => toggleEmojiPicker(row, m.id)));
      actions.appendChild(actionBtn("↩", "Ответить", () => startReply(m)));
      if (out) {
        actions.appendChild(actionBtn("✎", "Изменить", () => startEdit(m)));
        actions.appendChild(actionBtn("🗑", "Удалить", () => removeMessage(m.id)));
      }
      row.appendChild(actions);
    }

    return row;
  }

  function actionBtn(label, title, onclick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.onclick = onclick;
    return b;
  }

  function toggleEmojiPicker(row, messageId) {
    const existing = row.querySelector(".emoji-picker");
    if (existing) return existing.remove();
    const picker = document.createElement("div");
    picker.className = "emoji-picker";
    for (const emoji of QUICK_EMOJI) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = emoji;
      b.onclick = () => { react(messageId, emoji); picker.remove(); };
      picker.appendChild(b);
    }
    row.appendChild(picker);
    setTimeout(() => document.addEventListener("click", function close(ev) {
      if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener("click", close); }
    }), 0);
  }

  function patchMessage(m) {
    const list = state.messages.get(m.conversationId);
    if (!list) return;
    const idx = list.findIndex((x) => x.id === m.id);
    if (idx !== -1) list[idx] = m;
    const conv = state.conversations.find((c) => c.id === m.conversationId);
    if (conv?.lastMessage?.id === m.id) conv.lastMessage = m;
    if (m.conversationId === state.currentId) renderMessages();
    renderConversations();
  }

  function appendMessage(m) {
    const list = state.messages.get(m.conversationId) || [];
    if (list.some((x) => x.id === m.id)) return;
    list.push(m);
    state.messages.set(m.conversationId, list);

    const conv = state.conversations.find((c) => c.id === m.conversationId);
    if (conv) {
      conv.lastMessage = { ...m };
      conv.updatedAt = m.createdAt;
      state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    if (m.conversationId === state.currentId) {
      renderMessages();
      state.socket?.emit("conversation:read", { conversationId: m.conversationId });
    } else if (m.userId !== state.me.id) {
      if (conv) conv.unread = (conv.unread || 0) + 1;
      const title = conv ? convTitle(conv) : "Новое сообщение";
      const body = m.attachment && !m.text ? "📎 вложение" : m.text;
      notify(`${m.username} · ${title}`, body);
    }
    renderConversations();
  }

  // ---------- socket ----------
  function connectSocket() {
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on("connect_error", (err) => {
      if (String(err.message).includes("unauthorized")) {
        localStorage.removeItem("messenger.token");
        location.reload();
      }
    });
    socket.on("ready", ({ user }) => { state.me = { ...state.me, ...user }; });
    socket.on("message:new", ({ message }) => appendMessage(message));
    socket.on("message:update", ({ message }) => patchMessage(message));
    socket.on("message:delete", ({ message }) => patchMessage(message));
    socket.on("read:update", () => {});
    socket.on("presence:update", ({ online }) => {
      state.online = new Set(online);
      state.users.forEach((u) => (u.online = state.online.has(u.id)));
      renderOnline();
      renderConversations();
      if (state.currentId) {
        const conv = state.conversations.find((c) => c.id === state.currentId);
        if (conv) updateChatSub(conv);
      }
    });
    socket.on("user:update", ({ user }) => {
      state.users.set(user.id, { ...state.users.get(user.id), ...user });
      if (user.id === state.me.id) {
        state.me = { ...state.me, ...user };
        renderMe();
      }
      renderOnline();
      if (state.currentId) {
        const conv = state.conversations.find((c) => c.id === state.currentId);
        if (conv?.type === "dm") {
          $("#chat-title").textContent = convTitle(conv);
        }
      }
      renderMessages();
    });
    socket.on("conversation:update", ({ conversation }) => {
      const idx = state.conversations.findIndex((c) => c.id === conversation.id);
      if (idx !== -1) {
        state.conversations[idx] = { ...state.conversations[idx], ...conversation };
        if (conversation.id === state.currentId) {
          $("#chat-title").textContent = convTitle(state.conversations[idx]);
          updateChatSub(state.conversations[idx]);
        }
      }
      renderConversations();
    });
    socket.on("conversation:new", ({ conversation, label }) => {
      if (!state.conversations.some((c) => c.id === conversation.id)) {
        state.conversations.push(conversation);
        state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
        renderConversations();
        const name = conversation.type === "room" ? `#${conversation.name}` : conversation.name;
        toast(`${label || "Новый чат"}: ${name}`);
      }
    });
    socket.on("typing:update", ({ conversationId, username, typing }) => {
      if (conversationId !== state.currentId) return;
      const key = `${conversationId}:${username}`;
      clearTimeout(state.typingTimers.get(key));
      const set = state._typingSet || (state._typingSet = new Set());
      if (typing) {
        set.add(username);
        state.typingTimers.set(key, setTimeout(() => { set.delete(username); renderTyping(); }, 3000));
      } else {
        set.delete(username);
      }
      renderTyping();
    });
  }

  function renderTyping() {
    const names = [...(state._typingSet || new Set())];
    $("#typing").textContent = names.length
      ? `${names.join(", ")} ${names.length === 1 ? "печатает" : "печатают"}…`
      : "";
  }

  // ---------- actions ----------
  function startReply(m) {
    state.replyTo = m.id;
    $("#reply-name").textContent = m.username;
    $("#reply-text").textContent = m.deletedAt ? "(удалено)" : (m.text || "📎 вложение");
    $("#reply-bar").classList.remove("hidden");
    $("#input").focus();
  }
  function renderReplyBar() {
    if (!state.replyTo) $("#reply-bar").classList.add("hidden");
  }
  $("#reply-cancel").onclick = () => {
    state.replyTo = null;
    $("#reply-bar").classList.add("hidden");
  };

  function startEdit(m) {
    state.editingId = m.id;
    $("#input").value = m.text;
    $("#input").focus();
    $("#input").placeholder = "Редактирование… (Esc — отмена)";
    toast("Редактирование сообщения — Enter, чтобы сохранить");
  }

  async function removeMessage(id) {
    const res = await new Promise((r) => state.socket.emit("message:delete", { messageId: id }, r));
    if (!res?.ok) toast(res?.error || "Ошибка удаления");
  }

  async function react(messageId, emoji) {
    const res = await new Promise((r) => state.socket.emit("message:react", { messageId, emoji }, r));
    if (!res?.ok) toast(res?.error || "Ошибка реакции");
  }

  function renderAttachPreview() {
    if (state.attachment) {
      $("#attach-name").textContent = `📎 ${state.attachment.name} (${fmtSize(state.attachment.size)})`;
      $("#attach-preview").classList.remove("hidden");
    } else {
      $("#attach-preview").classList.add("hidden");
    }
  }
  $("#attach-cancel").onclick = () => { state.attachment = null; renderAttachPreview(); };
  $("#attach-btn").onclick = () => $("#file-input").click();
  $("#file-input").onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { attachment } = await api("/api/upload", { method: "POST", body: fd });
      state.attachment = attachment;
      renderAttachPreview();
    } catch (err) {
      toast(err.message);
    }
  };

  function openLightbox(url) {
    $("#lightbox-img").src = url;
    $("#lightbox").classList.remove("hidden");
  }
  $("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");

  // ---------- composer ----------
  const input = $("#input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    if (state.currentId && !state.editingId) {
      state.socket?.emit("typing", { conversationId: state.currentId, typing: true });
      clearTimeout(state._stopTyping);
      state._stopTyping = setTimeout(() => {
        state.socket?.emit("typing", { conversationId: state.currentId, typing: false });
      }, 1500);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      state.editingId = null;
      input.value = "";
      input.placeholder = "Напишите сообщение… (Enter — отправить, Shift+Enter — перенос)";
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });

  $("#composer").onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!state.currentId) return;

    if (state.editingId) {
      const id = state.editingId;
      state.editingId = null;
      input.placeholder = "Напишите сообщение… (Enter — отправить, Shift+Enter — перенос)";
      input.value = "";
      input.style.height = "auto";
      state.socket.emit("message:edit", { messageId: id, text }, (res) => {
        if (!res?.ok) toast(res?.error || "Ошибка редактирования");
      });
      return;
    }

    if (!text && !state.attachment) return;
    const payload = {
      conversationId: state.currentId,
      text,
      attachment: state.attachment,
      replyTo: state.replyTo,
      clientId: "c_" + Math.random().toString(36).slice(2),
    };
    input.value = "";
    input.style.height = "auto";
    state.replyTo = null;
    state.attachment = null;
    renderReplyBar();
    renderAttachPreview();
    state.socket.emit("message:send", payload, (res) => {
      if (!res?.ok) toast(res?.error || "Не удалось отправить");
    });
    state.socket.emit("typing", { conversationId: state.currentId, typing: false });
  };

  // ---------- presence ----------
  function renderOnline() {
    const box = $("#online-list");
    box.innerHTML = "";
    const users = [...state.users.values()].filter((u) => u.id !== state.me?.id && state.online.has(u.id));
    $("#online-count").textContent = users.length;
    for (const u of users) {
      const chip = document.createElement("div");
      chip.className = "online-chip";
      chip.innerHTML = `<span class="dot"></span>`;
      chip.appendChild(avatarEl(u, "avatar-sm"));
      chip.appendChild(document.createTextNode(u.username));
      chip.onclick = () => startDm(u.id);
      box.appendChild(chip);
    }
    if (!users.length) box.innerHTML = `<span class="muted small">никого</span>`;
  }

  // ---------- modals ----------
  function openModal({ title, body, okText = "Создать", onOk }) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = body;
    $("#modal-ok").textContent = okText;
    $("#modal").classList.remove("hidden");
    $("#modal-ok").onclick = async () => {
      try {
        await onOk();
        closeModal();
      } catch (err) {
        toast(err.message);
      }
    };
  }
  function closeModal() { $("#modal").classList.add("hidden"); }
  $("#modal-cancel").onclick = closeModal;
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  $("#new-room").onclick = () => {
    openModal({
      title: "Новая комната",
      body: `<input id="room-name" placeholder="Название комнаты" maxlength="30" />`,
      onOk: async () => {
        const name = $("#room-name").value.trim();
        const { conversation } = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify({ type: "room", name }),
        });
        if (!state.conversations.some((c) => c.id === conversation.id)) {
          state.conversations.push(conversation);
          renderConversations();
        }
        openConversation(conversation.id);
      },
    });
    setTimeout(() => $("#room-name")?.focus(), 30);
  };

  $("#new-group").onclick = () => {
    const others = [...state.users.values()].filter((u) => u.id !== state.me.id);
    if (!others.length) return toast("Пока нет других пользователей");
    const boxes = others
      .map((u) => `<label class="pick"><input type="checkbox" value="${u.id}" /> ${esc(u.username)}${state.online.has(u.id) ? " ●" : ""}</label>`)
      .join("");
    openModal({
      title: "Новая группа",
      body: `<input id="group-name" placeholder="Название группы" maxlength="40" />
        <div class="pick-list">${boxes}</div>`,
      onOk: async () => {
        const name = $("#group-name").value.trim();
        const memberIds = [...document.querySelectorAll("#modal-body input[type=checkbox]:checked")].map((c) => c.value);
        const { conversation } = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify({ type: "group", name, memberIds }),
        });
        if (!state.conversations.some((c) => c.id === conversation.id)) {
          state.conversations.push(conversation);
          renderConversations();
        }
        openConversation(conversation.id);
      },
    });
    setTimeout(() => $("#group-name")?.focus(), 30);
  };

  $("#profile-btn").onclick = () => {
    openModal({
      title: "Профиль",
      okText: "Сохранить",
      body: `<div class="profile-preview">
          <span id="profile-avatar" class="avatar"></span>
          <div>
            <input id="profile-name" value="${esc(state.me.username)}" maxlength="20" />
            <p class="muted small" style="margin:6px 0 0">Имя: 3-20 символов (буквы, цифры, _ . -)</p>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" id="avatar-upload" class="ghost" style="flex:1">Сменить аватар</button>
          <button type="button" id="avatar-remove" class="ghost" style="flex:1">Убрать</button>
        </div>
        <input type="file" id="avatar-input" accept="image/*" class="hidden" />`,
      onOk: async () => {
        const username = $("#profile-name").value.trim();
        const patch = {};
        if (username && username !== state.me.username) patch.username = username;
        if (state._pendingAvatar !== undefined) patch.avatar = state._pendingAvatar;
        if (!Object.keys(patch).length) return;
        const { user } = await api("/api/me", { method: "PATCH", body: JSON.stringify(patch) });
        state.me = { ...state.me, ...user };
        state.users.set(user.id, { ...state.users.get(user.id), ...user });
        state._pendingAvatar = undefined;
        renderMe();
        renderMessages();
      },
    });
    const preview = $("#profile-avatar");
    updateAvatarEl(preview, state.me);
    state._pendingAvatar = undefined;
    $("#avatar-upload").onclick = () => $("#avatar-input").click();
    $("#avatar-remove").onclick = () => {
      state._pendingAvatar = null;
      updateAvatarEl(preview, { ...state.me, avatar: null });
    };
    $("#avatar-input").onchange = async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const { attachment } = await api("/api/upload", { method: "POST", body: fd });
        state._pendingAvatar = attachment.url;
        updateAvatarEl(preview, { ...state.me, avatar: attachment.url });
      } catch (err) {
        toast(err.message);
      }
    };
  };

  async function startDm(userId) {
    const { conversation } = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "dm", userId }),
    });
    if (!state.conversations.some((c) => c.id === conversation.id)) {
      state.conversations.push(conversation);
      renderConversations();
    }
    openConversation(conversation.id);
  }

  $("#new-dm").onclick = () => {
    const options = [...state.users.values()]
      .filter((u) => u.id !== state.me.id)
      .map((u) => `<option value="${u.id}">${esc(u.username)}${state.online.has(u.id) ? " ●" : ""}</option>`)
      .join("");
    if (!options) return toast("Пока нет других пользователей");
    openModal({
      title: "Новый личный чат",
      body: `<select id="dm-user">${options}</select>`,
      okText: "Открыть",
      onOk: async () => { await startDm($("#dm-user").value); },
    });
  };

  $("#search").addEventListener("input", renderConversations);
  $("#menu-toggle").onclick = () => $(".sidebar").classList.toggle("open");

  // ---------- boot ----------
  (async function boot() {
    if (!state.token) return;
    try {
      const { user } = await api("/api/me");
      state.me = user;
      await enterApp();
    } catch {
      localStorage.removeItem("messenger.token");
    }
  })();
})();
