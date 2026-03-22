/**
 * MARK OS — Frontend Engine v2.0
 * Блоки: StateManager, SocketEngine, UI, AppController
 */

// ============================================================
//  STATE MANAGER
// ============================================================
function createStateManager(init) {
  let state = { ...init };
  const subs = [];

  function getState(key) { return key ? state[key] : state; }

  function dispatch(key, updater) {
    const prev = state[key];
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (prev === next) return;
    state = { ...state, [key]: next };
    subs.forEach(({ key: k, fn }) => { if (k === null || k === key) fn(next, prev, key); });
  }

  function subscribe(key, fn) {
    const e = { key, fn };
    subs.push(e);
    return () => subs.splice(subs.indexOf(e), 1);
  }

  return { getState, dispatch, subscribe };
}

const State = createStateManager({
  currentUser:    null,
  rooms:          new Map(),
  users:          new Map(),
  messages:       new Map(),
  activeRoomId:   "global",
  typingUsers:    new Set(),
  screen:         "login",
  connectionStatus: "connecting",
  userScrolledUp: false,
  replyTo:        null,   // { id, text, author }
  editingMsg:     null,   // { id, text }
  theme:          "dark",
  msgCount:       0,
});

// ============================================================
//  SOCKET ENGINE
// ============================================================
const SocketEngine = (function () {
  let socket = null;

  function connect() {
    socket = io(window.location.origin, { transports: ["websocket", "polling"], reconnectionDelay: 1000 });
    _bind();
    return socket;
  }

  function _bind() {
    socket.on("connect",    () => { State.dispatch("connectionStatus", "connected"); });
    socket.on("disconnect", () => { State.dispatch("connectionStatus", "disconnected"); UI.showToast("Соединение потеряно", "error"); });

    socket.on("auth_success", ({ user, rooms, users }) => {
      State.dispatch("currentUser", user);
      State.dispatch("theme", user.theme || "dark");
      const rm = new Map(); rooms.forEach(r => rm.set(r.id, r));
      State.dispatch("rooms", rm);
      const um = new Map(); users.forEach(u => um.set(u.id, u));
      State.dispatch("users", um);
      State.dispatch("screen", "chat");
      socket.emit("join_room", { roomId: "global" });
    });

    socket.on("auth_error", ({ message }) => UI.showToast(message, "error"));

    socket.on("new_message", (msg) => {
      _addMsg(msg);
      State.dispatch("msgCount", c => c + 1);
      if (msg.roomId !== State.getState("activeRoomId")) {
        _markUnread(msg.roomId);
        if (msg.roomId.startsWith("dm_")) { UI.playPing(); _notify(msg); }
      }
    });

    socket.on("room_history", ({ roomId, messages }) => {
      State.dispatch("messages", prev => { const n = new Map(prev); n.set(roomId, messages); return n; });
    });

    socket.on("message_edited", ({ roomId, messageId, newText }) => {
      State.dispatch("messages", prev => {
        const n = new Map(prev);
        n.set(roomId, (n.get(roomId) || []).map(m => m.id === messageId ? { ...m, text: newText, edited: true } : m));
        return n;
      });
    });

    socket.on("message_deleted", ({ roomId, messageId }) => {
      State.dispatch("messages", prev => {
        const n = new Map(prev);
        n.set(roomId, (n.get(roomId) || []).filter(m => m.id !== messageId));
        return n;
      });
    });

    socket.on("message_reacted", ({ roomId, messageId, reactions }) => {
      State.dispatch("messages", prev => {
        const n = new Map(prev);
        n.set(roomId, (n.get(roomId) || []).map(m => m.id === messageId ? { ...m, reactions } : m));
        return n;
      });
    });

    socket.on("user_joined", ({ user }) => {
      State.dispatch("users", prev => { const n = new Map(prev); n.set(user.id, user); return n; });
      UI.showToast(`${user.username} присоединился`, "info");
    });

    socket.on("user_left", ({ userId, username }) => {
      State.dispatch("users", prev => { const n = new Map(prev); n.delete(userId); return n; });
      UI.showToast(`${username} вышел`, "info");
    });

    socket.on("user_updated", ({ user }) => {
      State.dispatch("users", prev => { const n = new Map(prev); n.set(user.id, user); return n; });
    });

    socket.on("profile_updated", ({ user }) => {
      State.dispatch("currentUser", user);
    });

    socket.on("dm_ready", ({ room, history, partner }) => {
      State.dispatch("rooms", prev => { const n = new Map(prev); n.set(room.id, room); return n; });
      State.dispatch("messages", prev => { const n = new Map(prev); n.set(room.id, history); return n; });
      AppController.switchRoom(room.id);
    });

    socket.on("dm_incoming", ({ room, from }) => {
      State.dispatch("rooms", prev => { const n = new Map(prev); n.set(room.id, room); return n; });
      UI.showToast(`💬 ${from.username} написал вам`, "dm");
      UI.renderChatList();
    });

    socket.on("user_typing", ({ userId, username, roomId }) => {
      if (roomId !== State.getState("activeRoomId")) return;
      State.dispatch("typingUsers", prev => { const n = new Set(prev); n.add(userId); return n; });
    });

    socket.on("typing_stopped", ({ userId }) => {
      State.dispatch("typingUsers", prev => { const n = new Set(prev); n.delete(userId); return n; });
    });

    socket.on("error_event",      ({ message }) => UI.showToast(message, "error"));
    socket.on("permission_denied",({ message }) => UI.showToast("🚫 " + message, "error"));
    socket.on("pong_server",      ({ ts })      => UI.updateLatency(Date.now() - ts));
  }

  function _addMsg(msg) {
    State.dispatch("messages", prev => {
      const n = new Map(prev);
      const list = [...(n.get(msg.roomId) || []), msg].slice(-500);
      n.set(msg.roomId, list);
      return n;
    });
  }

  function _markUnread(roomId) {
    const rooms = State.getState("rooms");
    const room  = rooms.get(roomId);
    if (room) { room._unread = (room._unread || 0) + 1; UI.renderChatList(); }
  }

  function _notify(msg) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(`MARK OS — ${msg.author}`, { body: msg.text || "📎 Медиа", icon: "/favicon.ico" });
  }

  function auth(username)                        { socket?.emit("auth", { username }); }
  function sendMessage(roomId, text, meta)        { socket?.emit("send_message", { roomId, text, mediaUrl: meta?.mediaUrl || null, mediaType: meta?.mediaType || null, replyToId: meta?.replyToId || null }); }
  function editMessage(roomId, messageId, text)   { socket?.emit("edit_message", { roomId, messageId, newText: text }); }
  function deleteMessage(roomId, messageId)        { socket?.emit("delete_message", { roomId, messageId }); }
  function reactMessage(roomId, messageId, emoji)  { socket?.emit("react_message", { roomId, messageId, emoji }); }
  function joinRoom(roomId)                        { socket?.emit("join_room", { roomId }); }
  function openDM(targetUserId)                    { socket?.emit("open_dm", { targetUserId }); }
  function typingStart(roomId)                     { socket?.emit("typing_start", { roomId }); }
  function typingStop(roomId)                      { socket?.emit("typing_stop", { roomId }); }
  function ping()                                  { socket?.emit("ping_server"); }
  function updateProfile(data)                     { socket?.emit("update_profile", data); }

  return { connect, auth, sendMessage, editMessage, deleteMessage, reactMessage, joinRoom, openDM, typingStart, typingStop, ping, updateProfile };
})();

// ============================================================
//  UI
// ============================================================
const UI = (function () {
  const $ = {};

  function init() {
    $.loginScreen   = document.getElementById("login-screen");
    $.chatScreen    = document.getElementById("chat-screen");
    $.usernameInput = document.getElementById("username-input");
    $.loginBtn      = document.getElementById("login-btn");
    $.chatList      = document.getElementById("chat-list");
    $.userList      = document.getElementById("user-list");
    $.messageList   = document.getElementById("message-list");
    $.messageInput  = document.getElementById("message-input");
    $.sendBtn       = document.getElementById("send-btn");
    $.headerTitle   = document.getElementById("chat-header-title");
    $.headerStatus  = document.getElementById("chat-header-status");
    $.headerAvatar  = document.getElementById("chat-header-avatar");
    $.typingEl      = document.getElementById("typing-indicator");
    $.toastBox      = document.getElementById("toast-container");
    $.onlineCount   = document.getElementById("online-count");
    $.channelBadge  = document.getElementById("channel-badge");
    $.activeChat    = document.getElementById("active-chat");
    $.emptyState    = document.getElementById("empty-state");
    $.leftPanel     = document.getElementById("left-panel");
    $.rightPanel    = document.getElementById("right-panel");
    $.backBtn       = document.getElementById("back-btn");
    $.attachBtn     = document.getElementById("attach-btn");
    $.fileInput     = document.getElementById("file-input");
    $.replyBar      = document.getElementById("reply-bar");
    $.replyText     = document.getElementById("reply-text");
    $.replyCancel   = document.getElementById("reply-cancel");
    $.editBar       = document.getElementById("edit-bar");
    $.editText      = document.getElementById("edit-text");
    $.editCancel    = document.getElementById("edit-cancel");
    $.profileModal  = document.getElementById("profile-modal");
    $.contextMenu   = document.getElementById("context-menu");
    $.searchInput   = document.getElementById("search-input");
    $.themeToggle   = document.getElementById("theme-toggle");
    $.latencyEl     = document.getElementById("latency-display");
    $.profileAvatar = document.getElementById("profile-avatar");
    $.profileName   = document.getElementById("profile-name");
    $.profileRole   = document.getElementById("profile-role");
    $.profileBioInput = document.getElementById("profile-bio-input");
    $.profileSaveBtn  = document.getElementById("profile-save-btn");
    $.profileMsgCount = document.getElementById("profile-msg-count");

    _bindScroll();
    _bindInput();
    _bindActions();
  }

  // ── ЭКРАНЫ ─────────────────────────────────────────────────
  function switchScreen(screen) {
    if (screen === "chat") {
      $.loginScreen.classList.add("hidden");
      $.chatScreen.classList.remove("hidden");
    } else {
      $.loginScreen.classList.remove("hidden");
      $.chatScreen.classList.add("hidden");
    }
  }

  // ── ТЕМА ───────────────────────────────────────────────────
  function applyTheme(theme) {
    document.body.classList.toggle("light-theme", theme === "light");
    if ($.themeToggle) $.themeToggle.textContent = theme === "light" ? "🌙" : "☀️";
  }

  // ── СПИСОК ЧАТОВ ───────────────────────────────────────────
  function renderChatList() {
    const rooms        = State.getState("rooms");
    const allMessages  = State.getState("messages");
    const activeRoomId = State.getState("activeRoomId");
    const query        = ($.searchInput?.value || "").toLowerCase();
    if (!$.chatList) return;
    $.chatList.innerHTML = "";

    const sections = [
      { type: "global",  label: "Основное"  },
      { type: "channel", label: "Каналы"    },
      { type: "dm",      label: "Переписки" },
    ];

    sections.forEach(({ type, label }) => {
      const list = [];
      rooms.forEach(r => { if (r.type === type) list.push(r); });
      const filtered = query ? list.filter(r => r.name.toLowerCase().includes(query)) : list;
      if (!filtered.length) return;

      const lbl = document.createElement("div");
      lbl.className = "chat-section-label";
      lbl.textContent = label;
      $.chatList.appendChild(lbl);

      filtered.forEach(room => {
        const msgs    = allMessages.get(room.id) || [];
        const lastMsg = msgs[msgs.length - 1];
        const preview = lastMsg ? `${lastMsg.author}: ${lastMsg.text || "📎"}`.slice(0, 50) : "Нет сообщений";
        const timeStr = lastMsg ? _fmtTime(lastMsg.timestamp) : "";
        const icon    = room.type === "global" ? "🌐" : room.type === "channel" ? "📢" : "💬";

        const el = document.createElement("div");
        el.className = "chat-item" + (room.id === activeRoomId ? " active" : "");
        el.innerHTML = `
          <div class="chat-item-avatar" style="background:${_color(room.name)}">${icon}</div>
          <div class="chat-item-body">
            <div class="chat-item-top">
              <span class="chat-item-name">${_esc(room.name)}</span>
              <span class="chat-item-time">${timeStr}</span>
            </div>
            <div class="chat-item-preview ${room._unread ? "unread" : ""}">${_esc(preview)}</div>
          </div>
          ${room._unread ? `<div class="chat-item-badge">${room._unread}</div>` : ""}
        `;
        el.addEventListener("click", () => AppController.switchRoom(room.id));
        $.chatList.appendChild(el);
      });
    });
  }

  // ── СПИСОК ПОЛЬЗОВАТЕЛЕЙ ───────────────────────────────────
  function renderUserList() {
    const users = State.getState("users");
    const me    = State.getState("currentUser");
    if (!$.userList) return;
    $.userList.innerHTML = "";
    if ($.onlineCount) $.onlineCount.textContent = users.size;

    users.forEach(user => {
      const isMe = me && user.id === me.id;
      const el   = document.createElement("div");
      el.className = "user-item";
      el.innerHTML = `
        <div class="user-av" style="background:${user.avatarColor || _color(user.username)}">${_esc(user.avatar)}</div>
        <div class="user-info">
          <div class="user-name">${_esc(user.username)}${isMe ? ' <span style="color:var(--text-3)">(ты)</span>' : ""}</div>
          ${user.bio ? `<div class="user-bio">${_esc(user.bio)}</div>` : ""}
          ${user.isAdmin ? '<div class="admin-tag">ADMIN</div>' : ""}
        </div>
        <div class="user-dot"></div>
      `;
      if (!isMe) {
        el.style.cursor = "pointer";
        el.title = `Написать ${user.username}`;
        el.addEventListener("click", () => SocketEngine.openDM(user.id));
      }
      $.userList.appendChild(el);
    });
  }

  // ── СООБЩЕНИЯ ──────────────────────────────────────────────
  function renderMessages() {
    const roomId  = State.getState("activeRoomId");
    const msgs    = (State.getState("messages").get(roomId) || []);
    const me      = State.getState("currentUser");
    if (!$.messageList) return;
    $.messageList.innerHTML = "";

    let lastAuthorId = null, lastTs = 0;

    msgs.forEach((msg, idx) => {
      const isMe     = me && msg.authorId === me.id;
      const sameAuth = msg.authorId === lastAuthorId;
      const closeTs  = (msg.timestamp - lastTs) < 300000;
      const compact  = sameAuth && closeTs;

      const el = document.createElement("div");
      el.className = `msg-wrapper ${isMe ? "mine" : "theirs"}${compact ? " compact" : ""}`;
      el.dataset.msgId = msg.id;

      const time      = _fmtTime(msg.timestamp);
      const replyHTML = msg.replyTo ? `
        <div class="msg-reply" onclick="AppController.scrollToMsg('${msg.replyTo.id}')">
          <span class="reply-author">${_esc(msg.replyTo.author)}</span>
          <span class="reply-text">${_esc((msg.replyTo.text || "📎").slice(0, 60))}</span>
        </div>` : "";

      const mediaHTML = msg.mediaUrl
        ? (msg.mediaType === "image"
          ? `<img class="msg-image" src="${_esc(msg.mediaUrl)}" onclick="UI.openMedia('${_esc(msg.mediaUrl)}')" loading="lazy"/>`
          : `<video class="msg-video" src="${_esc(msg.mediaUrl)}" controls playsinline></video>`)
        : "";

      const reactHTML = _renderReactions(msg, roomId);

      const avatarHTML = compact ? `<div class="msg-av-spacer"></div>` : `
        <div class="msg-av" style="background:${msg.avatarColor || _color(msg.author)}">${_esc(msg.avatar)}</div>`;

      el.innerHTML = `
        ${avatarHTML}
        <div class="msg-body">
          ${!compact && !isMe ? `<div class="msg-name">${_esc(msg.author)}${msg.isAdmin ? " 👑" : ""}</div>` : ""}
          <div class="msg-bubble">
            ${replyHTML}
            ${mediaHTML}
            ${msg.text ? `<p class="msg-text">${_fmtText(msg.text)}${msg.edited ? ' <span class="msg-edited">изм.</span>' : ""}</p>` : ""}
            <div class="msg-meta">
              <span class="msg-time">${time}</span>
              ${isMe ? '<span class="msg-status">✓✓</span>' : ""}
            </div>
          </div>
          ${reactHTML}
        </div>
      `;

      // Контекстное меню
      el.addEventListener("contextmenu", e => { e.preventDefault(); _showCtxMenu(e, msg, isMe, roomId); });
      let ltimer = null;
      el.addEventListener("touchstart",  () => { ltimer = setTimeout(() => _showCtxMenu(null, msg, isMe, roomId), 600); });
      el.addEventListener("touchend",    () => clearTimeout(ltimer));
      el.addEventListener("touchmove",   () => clearTimeout(ltimer));

      if (idx === msgs.length - 1) el.classList.add("msg-appear");
      $.messageList.appendChild(el);

      lastAuthorId = msg.authorId;
      lastTs       = msg.timestamp;
    });

    if (!State.getState("userScrolledUp")) _scrollBottom(false);
    else _showScrollBtn();
  }

  // ── TYPING ──────────────────────────────────────────────────
  function renderTyping() {
    const typing = State.getState("typingUsers");
    const users  = State.getState("users");
    if (!$.typingEl) return;
    if (typing.size === 0) { $.typingEl.classList.add("hidden"); return; }
    const names = [];
    typing.forEach(id => { const u = users.get(id); if (u) names.push(u.username); });
    $.typingEl.querySelector(".typing-text").textContent =
      names.length === 1 ? `${names[0]} печатает` : `${names.join(", ")} печатают`;
    $.typingEl.classList.remove("hidden");
  }

  // ── ХЕДЕР ЧАТА ─────────────────────────────────────────────
  function updateHeader(room) {
    if (!room) return;
    if ($.headerTitle)  $.headerTitle.textContent  = room.name;
    if ($.headerAvatar) { $.headerAvatar.textContent = room.type === "global" ? "🌐" : room.type === "channel" ? "📢" : "💬"; $.headerAvatar.style.background = _color(room.name); }
    if ($.headerStatus) $.headerStatus.textContent = room.type === "dm" ? "личные сообщения" : room.type === "channel" ? "канал" : "общий чат";
    if ($.emptyState)   $.emptyState.classList.add("hidden");
    if ($.activeChat)   $.activeChat.classList.remove("hidden");
    if ($.rightPanel)   $.rightPanel.classList.add("visible-mobile");
    if ($.leftPanel)    $.leftPanel.classList.add("hidden-mobile");

    const me = State.getState("currentUser");
    const ro = room.type === "channel" && (!me || !me.isAdmin);
    if ($.channelBadge) ro ? $.channelBadge.classList.remove("hidden") : $.channelBadge.classList.add("hidden");
    if ($.messageInput) { $.messageInput.disabled = ro; $.messageInput.placeholder = ro ? "" : "Сообщение..."; }
    if ($.sendBtn)      $.sendBtn.disabled = ro;
  }

  // ── REPLY BAR ───────────────────────────────────────────────
  function showReplyBar(msg) {
    State.dispatch("replyTo", { id: msg.id, text: msg.text, author: msg.author });
    State.dispatch("editingMsg", null);
    if ($.replyBar)  $.replyBar.classList.remove("hidden");
    if ($.editBar)   $.editBar.classList.add("hidden");
    if ($.replyText) $.replyText.textContent = `${msg.author}: ${(msg.text || "📎").slice(0, 60)}`;
    $.messageInput?.focus();
  }

  function hideReplyBar() {
    State.dispatch("replyTo", null);
    if ($.replyBar) $.replyBar.classList.add("hidden");
  }

  // ── EDIT BAR ────────────────────────────────────────────────
  function showEditBar(msg) {
    State.dispatch("editingMsg", { id: msg.id, text: msg.text });
    State.dispatch("replyTo", null);
    if ($.editBar)  $.editBar.classList.remove("hidden");
    if ($.replyBar) $.replyBar.classList.add("hidden");
    if ($.editText) $.editText.textContent = msg.text.slice(0, 60);
    if ($.messageInput) { $.messageInput.value = msg.text; $.messageInput.focus(); }
  }

  function hideEditBar() {
    State.dispatch("editingMsg", null);
    if ($.editBar) $.editBar.classList.add("hidden");
    if ($.messageInput) $.messageInput.value = "";
  }

  // ── ПРОФИЛЬ ─────────────────────────────────────────────────
  function showProfile() {
    const user = State.getState("currentUser");
    if (!user || !$.profileModal) return;
    $.profileModal.classList.remove("hidden");
    if ($.profileAvatar)   { $.profileAvatar.textContent = user.avatar; $.profileAvatar.style.background = user.avatarColor || _color(user.username); }
    if ($.profileName)     $.profileName.textContent     = user.username;
    if ($.profileRole)     $.profileRole.textContent     = user.isAdmin ? "👑 Администратор" : "👤 Участник";
    if ($.profileBioInput) $.profileBioInput.value       = user.bio || "";
    if ($.profileMsgCount) $.profileMsgCount.textContent = State.getState("msgCount");
  }

  function hideProfile() {
    if ($.profileModal) $.profileModal.classList.add("hidden");
  }

  // ── МЕДИА ПРОСМОТР ─────────────────────────────────────────
  function openMedia(url) {
    const overlay = document.createElement("div");
    overlay.className = "media-overlay";
    overlay.innerHTML = `<img src="${_esc(url)}" /><button class="media-close">✕</button>`;
    overlay.addEventListener("click", e => { if (e.target === overlay || e.target.classList.contains("media-close")) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ── КОНТЕКСТНОЕ МЕНЮ ────────────────────────────────────────
  function _showCtxMenu(e, msg, isMe, roomId) {
    hideCtxMenu();
    const menu = $.contextMenu;
    if (!menu) return;

    menu.innerHTML = `
      <div class="ctx-item" data-action="reply">↩️ Ответить</div>
      <div class="ctx-item" data-action="react">😊 Реакция</div>
      ${isMe ? `<div class="ctx-item" data-action="edit">✏️ Редактировать</div>` : ""}
      ${isMe ? `<div class="ctx-item danger" data-action="delete">🗑️ Удалить</div>` : ""}
    `;

    menu.classList.remove("hidden");

    if (e) {
      const x = Math.min(e.clientX, window.innerWidth  - 180);
      const y = Math.min(e.clientY, window.innerHeight - 160);
      menu.style.left = x + "px";
      menu.style.top  = y + "px";
    } else {
      menu.style.left = "50%";
      menu.style.top  = "50%";
      menu.style.transform = "translate(-50%,-50%)";
    }

    menu.querySelectorAll(".ctx-item").forEach(item => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        if (action === "reply")  showReplyBar(msg);
        if (action === "edit")   showEditBar(msg);
        if (action === "delete") { if (confirm("Удалить сообщение?")) SocketEngine.deleteMessage(roomId, msg.id); }
        if (action === "react")  _showEmojiPicker(msg, roomId);
        hideCtxMenu();
      });
    });
  }

  function hideCtxMenu() {
    if ($.contextMenu) {
      $.contextMenu.classList.add("hidden");
      $.contextMenu.style.transform = "";
    }
  }

  function _showEmojiPicker(msg, roomId) {
    const emojis = ["👍","❤️","😂","😮","😢","🔥","🎉","👏"];
    const picker = document.createElement("div");
    picker.className = "emoji-picker";
    picker.innerHTML = emojis.map(e => `<span class="emoji-opt" data-e="${e}">${e}</span>`).join("");
    picker.querySelectorAll(".emoji-opt").forEach(s => {
      s.addEventListener("click", () => { SocketEngine.reactMessage(roomId, msg.id, s.dataset.e); picker.remove(); });
    });
    document.body.appendChild(picker);
    setTimeout(() => picker.remove(), 5000);
  }

  function _renderReactions(msg, roomId) {
    if (!msg.reactions || !Object.keys(msg.reactions).length) return "";
    const me = State.getState("currentUser");
    return `<div class="msg-reactions">${
      Object.entries(msg.reactions).map(([emoji, users]) =>
        `<span class="reaction ${me && users.includes(me.id) ? "mine-react" : ""}"
          onclick="SocketEngine.reactMessage('${roomId}','${msg.id}','${emoji}')"
        >${emoji} ${users.length}</span>`
      ).join("")
    }</div>`;
  }

  // ── TOAST ───────────────────────────────────────────────────
  function showToast(msg, type = "info") {
    const icons = { success: "✓", error: "✕", info: "ℹ", dm: "💬" };
    const el    = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${icons[type] || "ℹ"}</span><span>${_esc(msg)}</span>`;
    $.toastBox.appendChild(el);
    el.getBoundingClientRect();
    el.classList.add("toast-visible");
    setTimeout(() => { el.classList.remove("toast-visible"); el.addEventListener("transitionend", () => el.remove(), { once: true }); }, 3500);
  }

  function updateLatency(ms) {
    if (!$.latencyEl) return;
    $.latencyEl.textContent = ms + "ms";
    $.latencyEl.className   = "latency-display " + (ms < 100 ? "good" : ms < 300 ? "ok" : "bad");
  }

  function markRoomUnread(roomId) {
    const room = State.getState("rooms").get(roomId);
    if (room) { room._unread = (room._unread || 0) + 1; renderChatList(); }
  }

  function playPing() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o   = ctx.createOscillator();
      const g   = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      g.gain.setValueAtTime(0.2, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.start(); o.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  function requestNotifPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  // ── СКРОЛЛ ──────────────────────────────────────────────────
  function _scrollBottom(smooth = true) {
    $.messageList?.scrollTo({ top: $.messageList.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }

  function _showScrollBtn() {
    let btn = document.getElementById("scroll-btn");
    if (btn) return;
    btn = document.createElement("button");
    btn.id = "scroll-btn";
    btn.className = "scroll-down-btn";
    btn.textContent = "↓";
    btn.onclick = () => { State.dispatch("userScrolledUp", false); _scrollBottom(true); btn.remove(); };
    $.messageList?.parentElement.appendChild(btn);
  }

  function _bindScroll() {
    $.messageList?.addEventListener("scroll", () => {
      const el      = $.messageList;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      State.dispatch("userScrolledUp", !atBottom);
      if (atBottom) document.getElementById("scroll-btn")?.remove();
    });
  }

  // ── ИНПУТ ────────────────────────────────────────────────── 
  function _bindInput() {
    let typingTimer = null, isTyping = false;

    $.messageInput?.addEventListener("input", () => {
      const roomId = State.getState("activeRoomId");
      if (!isTyping) { SocketEngine.typingStart(roomId); isTyping = true; }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { SocketEngine.typingStop(roomId); isTyping = false; }, 2000);
      $.messageInput.style.height = "auto";
      $.messageInput.style.height = Math.min($.messageInput.scrollHeight, 150) + "px";
    });

    $.messageInput?.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        clearTimeout(typingTimer); isTyping = false;
        AppController.sendMessage();
      }
    });

    $.sendBtn?.addEventListener("click", () => AppController.sendMessage());

    $.replyCancel?.addEventListener("click", () => hideReplyBar());
    $.editCancel?.addEventListener("click",  () => hideEditBar());

    $.attachBtn?.addEventListener("click", () => $.fileInput?.click());
    $.fileInput?.addEventListener("change", e => {
      Array.from(e.target.files).forEach(f => AppController.sendFile(f));
      $.fileInput.value = "";
    });
  }

  function _bindActions() {
    // Назад (мобиль)
    $.backBtn?.addEventListener("click", () => {
      $.rightPanel?.classList.remove("visible-mobile");
      $.leftPanel?.classList.remove("hidden-mobile");
    });

    // Тема
    $.themeToggle?.addEventListener("click", () => {
      const cur = State.getState("theme");
      const nxt = cur === "dark" ? "light" : "dark";
      State.dispatch("theme", nxt);
      applyTheme(nxt);
      SocketEngine.updateProfile({ theme: nxt });
    });

    // Профиль — кнопка сохранить
    $.profileSaveBtn?.addEventListener("click", () => {
      const bio = ($.profileBioInput?.value || "").trim().slice(0, 120);
      SocketEngine.updateProfile({ bio });
      showToast("Профиль сохранён", "success");
      hideProfile();
    });

    // Поиск
    $.searchInput?.addEventListener("input", () => renderChatList());

    // Закрытие контекстного меню
    document.addEventListener("click", e => {
      if ($.contextMenu && !$.contextMenu.contains(e.target)) hideCtxMenu();
    });

    // Клик на аватар в хедере → открыть профиль
    $.headerAvatar?.addEventListener("click", () => showProfile());

    // Запросить разрешение на уведомления
    requestNotifPermission();
  }

  // ── УТИЛИТЫ ─────────────────────────────────────────────────
  function _esc(s) {
    if (!s) return "";
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;");
  }

  function _fmtText(text) {
    let s = _esc(text);
    s = s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener" class="msg-link">$1</a>');
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  function _fmtTime(ts) {
    const d    = new Date(ts), now = new Date();
    const h    = String(d.getHours()).padStart(2,"0");
    const m    = String(d.getMinutes()).padStart(2,"0");
    const time = `${h}:${m}`;
    if (d.toDateString() === now.toDateString()) return time;
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return `вчера ${time}`;
    return `${d.getDate()}.${d.getMonth()+1} ${time}`;
  }

  function _color(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return `hsl(${Math.abs(h) % 360},55%,42%)`;
  }

  return {
    init, switchScreen, applyTheme,
    renderChatList, renderUserList, renderMessages, renderTyping,
    updateHeader, showReplyBar, hideReplyBar, showEditBar, hideEditBar,
    showProfile, hideProfile, openMedia, hideCtxMenu,
    showToast, updateLatency, markRoomUnread, playPing,
  };
})();

// ============================================================
//  APP CONTROLLER
// ============================================================
const AppController = (function () {

  function init() {
    UI.init();
    _bindState();
    _bindLogin();
    setInterval(() => { if (State.getState("screen") === "chat") SocketEngine.ping(); }, 5000);
  }

  function _bindState() {
    State.subscribe("screen",           s  => UI.switchScreen(s));
    State.subscribe("theme",            t  => UI.applyTheme(t));
    State.subscribe("rooms",            () => UI.renderChatList());
    State.subscribe("users",            () => UI.renderUserList());
    State.subscribe("messages",         () => UI.renderMessages());
    State.subscribe("typingUsers",      () => UI.renderTyping());
  }

  function _bindLogin() {
    document.getElementById("login-btn")?.addEventListener("click", handleLogin);
    document.getElementById("username-input")?.addEventListener("keydown", e => { if (e.key === "Enter") handleLogin(); });
  }

  function handleLogin() {
    const input    = document.getElementById("username-input");
    const username = (input?.value || "").trim();
    if (username.length < 2) {
      UI.showToast("Имя минимум 2 символа", "error");
      input?.classList.add("shake");
      input?.addEventListener("animationend", () => input.classList.remove("shake"), { once: true });
      return;
    }
    const btn = document.getElementById("login-btn");
    if (btn) { btn.disabled = true; btn.querySelector("span").textContent = "Подключение..."; }

    SocketEngine.connect();
    const check = setInterval(() => {
      const s = State.getState("connectionStatus");
      if (s === "connected")    { clearInterval(check); SocketEngine.auth(username); if (btn) { btn.disabled = false; btn.querySelector("span").textContent = "Начать"; } }
      if (s === "disconnected") { clearInterval(check); UI.showToast("Нет связи с сервером", "error"); if (btn) { btn.disabled = false; btn.querySelector("span").textContent = "Начать"; } }
    }, 100);
  }

  function sendMessage() {
    const input      = document.getElementById("message-input");
    const text       = (input?.value || "").trim();
    const roomId     = State.getState("activeRoomId");
    const editingMsg = State.getState("editingMsg");
    const replyTo    = State.getState("replyTo");

    if (!roomId) return;

    if (editingMsg) {
      if (!text) return;
      SocketEngine.editMessage(roomId, editingMsg.id, text);
      UI.hideEditBar();
      if (input) { input.value = ""; input.style.height = "auto"; }
      return;
    }

    if (!text) return;
    SocketEngine.sendMessage(roomId, text, { replyToId: replyTo?.id || null });
    UI.hideReplyBar();
    if (input) { input.value = ""; input.style.height = "auto"; input.focus(); }
  }

  function sendFile(file) {
    const roomId = State.getState("activeRoomId");
    if (!roomId) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) { UI.showToast("Только фото и видео", "error"); return; }
    if (file.size > 15 * 1024 * 1024) { UI.showToast("Файл слишком большой (макс. 15MB)", "error"); return; }
    const reader = new FileReader();
    reader.onload = e => SocketEngine.sendMessage(roomId, "", { mediaUrl: e.target.result, mediaType: file.type.startsWith("image/") ? "image" : "video" });
    reader.readAsDataURL(file);
  }

  function switchRoom(roomId) {
    const rooms = State.getState("rooms");
    const room  = rooms.get(roomId);
    if (!room) return;
    room._unread = 0;
    State.dispatch("activeRoomId", roomId);
    State.dispatch("typingUsers",  new Set());
    State.dispatch("userScrolledUp", false);
    UI.updateHeader(room);
    const msgs = State.getState("messages");
    if (!msgs.has(roomId)) SocketEngine.joinRoom(roomId);
    else UI.renderMessages();
    UI.renderChatList();
    UI.hideReplyBar();
    UI.hideEditBar();
  }

  function scrollToMsg(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("msg-highlight"); setTimeout(() => el.classList.remove("msg-highlight"), 1500); }
  }

  return { init, handleLogin, sendMessage, sendFile, switchRoom, scrollToMsg };
})();

// ── СТАРТ ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  AppController.init();
  UI.switchScreen(State.getState("screen"));
  UI.applyTheme(State.getState("theme"));
  document.getElementById("login-screen")?.classList.add("fade-up");
});
