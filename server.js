/**
 * MARK OS — Server Core v2.0
 * Новое: edit/delete/react/reply, профили, темы, статусы
 */

const http = require("http");
const path = require("path");
const fs   = require("fs");
const { v4: uuidv4 } = require("uuid");

const PORT          = process.env.PORT || 3000;
const MAX_HISTORY   = 100;
const TYPING_EXPIRE = 4000;

const Store = {
  users:     new Map(), // socketId -> User
  rooms:     new Map(), // roomId  -> Room
  userIndex: new Map(), // userId  -> socketId
  typing:    new Map(), // roomId  -> Map<userId, timer>
};

function initRooms() {
  [
    { id: "global",     type: "global",  name: "# Главный зал" },
    { id: "ch_news",    type: "channel", name: "📢 Новости"    },
    { id: "ch_updates", type: "channel", name: "🔧 Обновления" },
  ].forEach(r => Store.rooms.set(r.id, { ...r, members: new Set(), history: [], createdAt: Date.now() }));
}

// ── HTTP (статика) ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath.startsWith("/socket.io")) return;

  const filePath = path.join(__dirname, "public",
    urlPath === "/" ? "index.html" : urlPath);

  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css",
    ".js":   "text/javascript",
    ".ico":  "image/x-icon",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
    ".webp": "image/webp",
    ".mp4":  "video/mp4",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" }, pingTimeout: 60000 });

// ── SOCKET HANDLERS ─────────────────────────────────────────
io.on("connection", (socket) => {

  // АВТОРИЗАЦИЯ
  socket.on("auth", ({ username, bio, theme, avatarUrl }) => {
    if (!username || typeof username !== "string") return;
    const name    = username.trim().slice(0, 32);
    const userId  = uuidv4();
    const isAdmin = Store.users.size === 0;

    const user = {
      id: userId, socketId: socket.id,
      username: name,
      bio:      (bio || "").slice(0, 120),
      avatar:   name.slice(0, 2).toUpperCase(),
      avatarUrl: avatarUrl || null,
      avatarColor: null,
      isAdmin,
      online:   true,
      lastSeen: Date.now(),
      theme:    theme || "dark",
      joinedAt: Date.now(),
      story:    null,
    };

    Store.users.set(socket.id, user);
    Store.userIndex.set(userId, socket.id);
    joinRoom(socket, "global");

    socket.emit("auth_success", {
      user,
      rooms: getRooms(),
      users: getUsers(),
    });
    socket.broadcast.emit("user_joined", { user: publicUser(user) });
  });

  // ОТПРАВКА СООБЩЕНИЯ
  socket.on("send_message", ({ roomId, text, mediaUrl, mediaType, replyToId }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;

    const clean = (text || "").trim().slice(0, 4096);
    if (!clean && !mediaUrl) return;

    if (room.type === "channel" && !user.isAdmin) {
      socket.emit("permission_denied", { message: "Только администратор пишет в каналы" });
      return;
    }
    if (room.type === "dm" && !room.members.has(socket.id)) {
      socket.emit("permission_denied", { message: "Нет доступа" });
      return;
    }

    // Найти оригинал для reply
    let replyData = null;
    if (replyToId) {
      const orig = room.history.find(m => m.id === replyToId);
      if (orig) replyData = { id: orig.id, text: orig.text, author: orig.author };
    }

    const msg = {
      id:        uuidv4(),
      roomId,
      authorId:  user.id,
      author:    user.username,
      avatar:    user.avatar,
      avatarColor: user.avatarColor,
      text:      clean,
      timestamp: Date.now(),
      isAdmin:   user.isAdmin,
      mediaUrl:  mediaUrl  || null,
      mediaType: mediaType || null,
      replyTo:   replyData,
      reactions: {},
      edited:    false,
    };

    room.history.push(msg);
    if (room.history.length > MAX_HISTORY) room.history.shift();
    io.to(roomId).emit("new_message", msg);
    clearTyping(roomId, user.id, socket);
  });

  // РЕДАКТИРОВАНИЕ
  socket.on("edit_message", ({ roomId, messageId, newText }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const msg = room.history.find(m => m.id === messageId);
    if (!msg || msg.authorId !== user.id) return;
    const clean = (newText || "").trim().slice(0, 4096);
    if (!clean) return;
    msg.text   = clean;
    msg.edited = true;
    io.to(roomId).emit("message_edited", { roomId, messageId, newText: clean });
  });

  // УДАЛЕНИЕ
  socket.on("delete_message", ({ roomId, messageId }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const idx = room.history.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    if (room.history[idx].authorId !== user.id && !user.isAdmin) return;
    room.history.splice(idx, 1);
    io.to(roomId).emit("message_deleted", { roomId, messageId });
  });

  // РЕАКЦИЯ
  socket.on("react_message", ({ roomId, messageId, emoji }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const msg = room.history.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.id);
    if (idx === -1) msg.reactions[emoji].push(user.id);
    else msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    io.to(roomId).emit("message_reacted", { roomId, messageId, reactions: msg.reactions });
  });

  // ОБНОВЛЕНИЕ ПРОФИЛЯ
  socket.on("update_profile", ({ bio, theme, avatarColor, avatarUrl, story }) => {
    const user = Store.users.get(socket.id);
    if (!user) return;
    if (bio         !== undefined) user.bio         = (bio || "").slice(0, 120);
    if (theme       !== undefined) user.theme        = theme;
    if (avatarColor !== undefined) user.avatarColor  = avatarColor;
    if (avatarUrl   !== undefined) user.avatarUrl    = avatarUrl;
    if (story       !== undefined) user.story        = story ? { text: story, ts: Date.now() } : null;
    socket.emit("profile_updated", { user: publicUser(user) });
    socket.broadcast.emit("user_updated", { user: publicUser(user) });
  });

  // СОЗДАНИЕ ГРУППЫ
  socket.on("create_group", ({ name, memberIds }) => {
    const creator = Store.users.get(socket.id);
    if (!creator) return;
    if (!name || name.trim().length < 2) { socket.emit("error_event", { message: "Название группы слишком короткое" }); return; }
    const groupId = "grp_" + uuidv4().slice(0, 8);
    const group = {
      id: groupId,
      type: "group",
      name: name.trim().slice(0, 50),
      creatorId: creator.id,
      members: new Set(),
      history: [],
      createdAt: Date.now(),
    };
    Store.rooms.set(groupId, group);

    // Добавляем создателя
    joinRoom(socket, groupId);

    // Добавляем других участников
    (memberIds || []).forEach(uid => {
      const sid = Store.userIndex.get(uid);
      if (sid) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          joinRoom(s, groupId);
          s.emit("added_to_group", { room: { id: groupId, type: "group", name: group.name }, by: publicUser(creator) });
        }
      }
    });

    const roomData = { id: groupId, type: "group", name: group.name };
    socket.emit("group_created", { room: roomData, history: [] });
    io.to(groupId).emit("group_member_joined", { groupId, user: publicUser(creator) });
  });

  // JOIN ROOM
  socket.on("join_room", ({ roomId }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    joinRoom(socket, roomId);
    socket.emit("room_history", { roomId, messages: room.history });
  });

  // DM
  socket.on("open_dm", ({ targetUserId }) => {
    const me = Store.users.get(socket.id);
    if (!me || me.id === targetUserId) return;
    const tSock = Store.userIndex.get(targetUserId);
    const them  = tSock ? Store.users.get(tSock) : null;
    if (!them) { socket.emit("error_event", { message: "Пользователь офлайн" }); return; }

    const dmId = "dm_" + [me.id, targetUserId].sort().join("_");
    if (!Store.rooms.has(dmId)) {
      Store.rooms.set(dmId, { id: dmId, type: "dm", name: `${me.username} ↔ ${them.username}`, members: new Set(), history: [] });
    }
    joinRoom(socket, dmId);
    const tSocket = io.sockets.sockets.get(tSock);
    if (tSocket) joinRoom(tSocket, dmId);

    socket.emit("dm_ready", {
      room: { id: dmId, type: "dm", name: `💬 ${them.username}` },
      history: Store.rooms.get(dmId).history,
      partner: publicUser(them),
    });
    if (tSocket) tSocket.emit("dm_incoming", {
      room: { id: dmId, type: "dm", name: `💬 ${me.username}` },
      from: publicUser(me),
    });
  });

  // TYPING
  socket.on("typing_start", ({ roomId }) => {
    const user = Store.users.get(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    if (!Store.typing.has(roomId)) Store.typing.set(roomId, new Map());
    const rt = Store.typing.get(roomId);
    if (rt.has(user.id)) clearTimeout(rt.get(user.id));
    socket.to(roomId).emit("user_typing", { userId: user.id, username: user.username, roomId });
    rt.set(user.id, setTimeout(() => clearTyping(roomId, user.id, socket), TYPING_EXPIRE));
  });

  socket.on("typing_stop", ({ roomId }) => {
    const user = Store.users.get(socket.id);
    if (user) clearTyping(roomId, user.id, socket);
  });

  socket.on("ping_server", () => socket.emit("pong_server", { ts: Date.now() }));

  // DISCONNECT
  socket.on("disconnect", () => {
    const user = Store.users.get(socket.id);
    if (!user) return;
    user.online  = false;
    user.lastSeen = Date.now();
    Store.rooms.forEach(r => r.members.delete(socket.id));
    Store.userIndex.delete(user.id);
    Store.users.delete(socket.id);
    io.emit("user_left", { userId: user.id, username: user.username });
  });
});

// ── HELPERS ─────────────────────────────────────────────────
function joinRoom(socket, roomId) {
  socket.join(roomId);
  const room = Store.rooms.get(roomId);
  if (room) room.members.add(socket.id);
}

function clearTyping(roomId, userId, socket) {
  const rt = Store.typing.get(roomId);
  if (rt && rt.has(userId)) { clearTimeout(rt.get(userId)); rt.delete(userId); }
  socket.to(roomId).emit("typing_stopped", { userId, roomId });
}

function publicUser(u) {
  return { id: u.id, username: u.username, avatar: u.avatar, avatarUrl: u.avatarUrl, avatarColor: u.avatarColor, bio: u.bio, isAdmin: u.isAdmin, online: u.online, lastSeen: u.lastSeen, story: u.story };
}

function getRooms() {
  const r = [];
  Store.rooms.forEach(room => {
    if (room.type !== "dm") r.push({ id: room.id, type: room.type, name: room.name, count: room.members.size });
  });
  return r;
}

function getUsers() {
  const r = [];
  Store.users.forEach(u => r.push(publicUser(u)));
  return r;
}

// ── START ────────────────────────────────────────────────────
initRooms();
server.listen(PORT, () => {
  console.log(`\n  🚀 MARK OS v2.0 запущен на порту ${PORT}\n`);
});

module.exports = { server, io, Store };
