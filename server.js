/**
 * MARK OS — Server Core v4.0
 * Аккаунты: SQLite, регистрация/вход по MARK-ID + пароль
 */

const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");

const PORT          = process.env.PORT || 3000;
const MAX_HISTORY   = 100;
const TYPING_EXPIRE = 4000;

// ── БАЗА ДАННЫХ ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "markos.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT PRIMARY KEY,
    friend_id   TEXT UNIQUE NOT NULL,
    username    TEXT NOT NULL,
    password    TEXT NOT NULL,
    bio         TEXT DEFAULT "",
    avatar_url  TEXT DEFAULT NULL,
    avatar_color TEXT DEFAULT NULL,
    theme       TEXT DEFAULT "dark",
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
`);

// ── IN-MEMORY ────────────────────────────────────────────────
const Store = {
  sessions:  new Map(), // socketId -> { userId, accountId }
  online:    new Map(), // accountId -> socketId
  rooms:     new Map(),
  userIndex: new Map(), // accountId -> socketId
  typing:    new Map(),
};

function initRooms() {
  [{ id: "global", type: "global", name: "# Главный зал" }]
    .forEach(r => Store.rooms.set(r.id, { ...r, members: new Set(), history: [], createdAt: Date.now() }));
}

// ── HTTP ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath.startsWith("/socket.io")) return;
  const filePath = path.join(__dirname, "public", urlPath === "/" ? "index.html" : urlPath);
  const mime = {
    ".html": "text/html; charset=utf-8", ".css": "text/css",
    ".js": "text/javascript", ".ico": "image/x-icon",
    ".png": "image/png", ".svg": "image/svg+xml",
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" }, pingTimeout: 60000 });

// ── SOCKET ───────────────────────────────────────────────────
io.on("connection", (socket) => {

  // РЕГИСТРАЦИЯ
  socket.on("register", ({ username, password }) => {
    if (!username || !password) return;
    const name = username.trim().slice(0, 32);
    const pass = password.trim();

    if (name.length < 2)  { socket.emit("auth_error", { message: "Имя минимум 2 символа" }); return; }
    if (pass.length < 4)  { socket.emit("auth_error", { message: "Пароль минимум 4 символа" }); return; }
    if (pass.length > 64) { socket.emit("auth_error", { message: "Пароль слишком длинный" }); return; }

    const accountId = uuidv4();
    const friendId  = _genFriendId();
    const passHash  = _hash(pass);
    const now       = Date.now();

    try {
      db.prepare(`INSERT INTO accounts (id, friend_id, username, password, created_at, last_seen)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(accountId, friendId, name, passHash, now, now);
    } catch (e) {
      socket.emit("auth_error", { message: "Ошибка создания аккаунта" }); return;
    }

    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
    _loginSocket(socket, account);
    console.log(`[Register] ${name} → ${friendId}`);
  });

  // ВХОД
  socket.on("login", ({ friendId, password }) => {
    if (!friendId || !password) return;
    const id   = friendId.trim().toUpperCase();
    const pass = password.trim();

    const account = db.prepare("SELECT * FROM accounts WHERE friend_id = ?").get(id);
    if (!account) { socket.emit("auth_error", { message: `Аккаунт ${id} не найден` }); return; }
    if (account.password !== _hash(pass)) { socket.emit("auth_error", { message: "Неверный пароль" }); return; }

    // Обновляем last_seen
    db.prepare("UPDATE accounts SET last_seen = ? WHERE id = ?").run(Date.now(), account.id);

    _loginSocket(socket, account);
    console.log(`[Login] ${account.username} (${id})`);
  });

  // ОТПРАВКА СООБЩЕНИЯ
  socket.on("send_message", ({ roomId, text, mediaUrl, mediaType, replyToId }) => {
    const user = _getUser(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const clean = (text || "").trim().slice(0, 4096);
    if (!clean && !mediaUrl) return;

    if (room.type === "channel" && !user.isAdmin) { socket.emit("permission_denied", { message: "Только администратор пишет в каналы" }); return; }
    if (room.type === "dm" && !room.members.has(socket.id)) { socket.emit("permission_denied", { message: "Нет доступа" }); return; }

    let replyData = null;
    if (replyToId) {
      const orig = room.history.find(m => m.id === replyToId);
      if (orig) replyData = { id: orig.id, text: orig.text, author: orig.author };
    }

    const msg = {
      id: uuidv4(), roomId,
      authorId: user.id, author: user.username,
      avatar: user.avatar, avatarUrl: user.avatarUrl, avatarColor: user.avatarColor,
      text: clean, timestamp: Date.now(), isAdmin: user.isAdmin,
      mediaUrl: mediaUrl || null, mediaType: mediaType || null,
      replyTo: replyData, reactions: {}, edited: false,
    };

    room.history.push(msg);
    if (room.history.length > MAX_HISTORY) room.history.shift();
    io.to(roomId).emit("new_message", msg);
    clearTyping(roomId, user.id, socket);
  });

  // РЕДАКТИРОВАНИЕ
  socket.on("edit_message", ({ roomId, messageId, newText }) => {
    const user = _getUser(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const msg = room.history.find(m => m.id === messageId);
    if (!msg || msg.authorId !== user.id) return;
    const clean = (newText || "").trim().slice(0, 4096);
    if (!clean) return;
    msg.text = clean; msg.edited = true;
    io.to(roomId).emit("message_edited", { roomId, messageId, newText: clean });
  });

  // УДАЛЕНИЕ
  socket.on("delete_message", ({ roomId, messageId }) => {
    const user = _getUser(socket.id);
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
    const user = _getUser(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    const msg = room.history.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.id);
    if (idx === -1) msg.reactions[emoji].push(user.id);
    else msg.reactions[emoji].splice(idx, 1);
    if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    io.to(roomId).emit("message_reacted", { roomId, messageId, reactions: msg.reactions });
  });

  // ОБНОВЛЕНИЕ ПРОФИЛЯ
  socket.on("update_profile", ({ bio, theme, avatarColor, avatarUrl, story }) => {
    const user = _getUser(socket.id);
    if (!user) return;
    if (bio         !== undefined) { user.bio         = (bio || "").slice(0, 120); db.prepare("UPDATE accounts SET bio = ? WHERE id = ?").run(user.bio, user.id); }
    if (theme       !== undefined) { user.theme        = theme; db.prepare("UPDATE accounts SET theme = ? WHERE id = ?").run(theme, user.id); }
    if (avatarColor !== undefined) { user.avatarColor  = avatarColor; db.prepare("UPDATE accounts SET avatar_color = ? WHERE id = ?").run(avatarColor, user.id); }
    if (avatarUrl   !== undefined) { user.avatarUrl    = avatarUrl; db.prepare("UPDATE accounts SET avatar_url = ? WHERE id = ?").run(avatarUrl, user.id); }
    if (story       !== undefined) user.story = story ? { text: story, ts: Date.now() } : null;
    socket.emit("profile_updated", { user: publicUser(user) });
    socket.broadcast.emit("user_updated", { user: publicUser(user) });
  });

  // ДОБАВИТЬ ДРУГА
  socket.on("add_friend", ({ friendId }) => {
    const me = _getUser(socket.id);
    if (!me) return;
    let target = null;
    Store.userIndex.forEach((sid, aid) => {
      const u = _getUser(sid);
      if (u && u.friendId === friendId.toUpperCase()) target = u;
    });
    // Ищем офлайн в БД
    if (!target) {
      const acc = db.prepare("SELECT * FROM accounts WHERE friend_id = ?").get(friendId.toUpperCase());
      if (acc) { socket.emit("friend_request_sent", { to: { username: acc.username, friendId: acc.friend_id } }); socket.emit("info_event", { message: `${acc.username} офлайн, запрос будет доставлен при входе` }); return; }
    }
    if (!target) { socket.emit("error_event", { message: `Пользователь ${friendId} не найден` }); return; }
    if (target.id === me.id) { socket.emit("error_event", { message: "Нельзя добавить себя" }); return; }
    const tSid   = Store.userIndex.get(target.id);
    const tSock  = tSid ? io.sockets.sockets.get(tSid) : null;
    if (tSock) tSock.emit("friend_request", { from: publicUser(me) });
    socket.emit("friend_request_sent", { to: publicUser(target) });
  });

  socket.on("accept_friend", ({ fromUserId }) => {
    const me   = _getUser(socket.id);
    const fSid = Store.userIndex.get(fromUserId);
    const from = fSid ? _getUser(fSid) : null;
    if (!me || !from) return;
    socket.emit("friend_accepted", { user: publicUser(from) });
    const fSock = fSid ? io.sockets.sockets.get(fSid) : null;
    if (fSock) fSock.emit("friend_accepted", { user: publicUser(me) });
  });

  socket.on("decline_friend", ({ fromUserId }) => {
    const me = _getUser(socket.id);
    if (!me) return;
    const fSid  = Store.userIndex.get(fromUserId);
    const fSock = fSid ? io.sockets.sockets.get(fSid) : null;
    if (fSock) fSock.emit("friend_declined", { byUsername: me.username });
  });

  // СОЗДАНИЕ ГРУППЫ
  socket.on("create_group", ({ name, memberIds }) => {
    const creator = _getUser(socket.id);
    if (!creator || !name || name.trim().length < 2) return;
    const groupId = "grp_" + uuidv4().slice(0, 8);
    const group   = { id: groupId, type: "group", name: name.trim().slice(0, 50), creatorId: creator.id, members: new Set(), history: [], createdAt: Date.now() };
    Store.rooms.set(groupId, group);
    joinRoom(socket, groupId);
    (memberIds || []).forEach(uid => {
      const sid = Store.userIndex.get(uid);
      if (sid) { const s = io.sockets.sockets.get(sid); if (s) { joinRoom(s, groupId); s.emit("added_to_group", { room: { id: groupId, type: "group", name: group.name }, by: publicUser(creator) }); } }
    });
    socket.emit("group_created", { room: { id: groupId, type: "group", name: group.name }, history: [] });
  });

  // СОЗДАНИЕ КАНАЛА
  socket.on("create_channel", ({ name, description }) => {
    const creator = _getUser(socket.id);
    if (!creator || !creator.isAdmin) { socket.emit("permission_denied", { message: "Только администратор" }); return; }
    if (!name || name.trim().length < 2) return;
    const chId    = "ch_" + uuidv4().slice(0, 8);
    const channel = { id: chId, type: "channel", name: name.trim().slice(0, 50), description: (description || "").slice(0, 200), creatorId: creator.id, members: new Set(), history: [], createdAt: Date.now() };
    Store.rooms.set(chId, channel);
    joinRoom(socket, chId);
    io.emit("channel_created", { room: { id: chId, type: "channel", name: channel.name, description: channel.description } });
  });

  // JOIN ROOM
  socket.on("join_room", ({ roomId }) => {
    const user = _getUser(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    joinRoom(socket, roomId);
    socket.emit("room_history", { roomId, messages: room.history });
  });

  // DM
  socket.on("open_dm", ({ targetUserId }) => {
    const me  = _getUser(socket.id);
    if (!me || me.id === targetUserId) return;
    const tSid = Store.userIndex.get(targetUserId);
    const them = tSid ? _getUser(tSid) : null;
    if (!them) { socket.emit("error_event", { message: "Пользователь офлайн" }); return; }
    const dmId = "dm_" + [me.id, targetUserId].sort().join("_");
    if (!Store.rooms.has(dmId)) Store.rooms.set(dmId, { id: dmId, type: "dm", name: `${me.username} ↔ ${them.username}`, members: new Set(), history: [] });
    joinRoom(socket, dmId);
    const tSock = io.sockets.sockets.get(tSid);
    if (tSock) joinRoom(tSock, dmId);
    socket.emit("dm_ready", { room: { id: dmId, type: "dm", name: `💬 ${them.username}` }, history: Store.rooms.get(dmId).history, partner: publicUser(them) });
    if (tSock) tSock.emit("dm_incoming", { room: { id: dmId, type: "dm", name: `💬 ${me.username}` }, from: publicUser(me) });
  });


  // ДОБАВИТЬ В ГРУППУ
  socket.on("add_to_group", ({ groupId, targetUserId }) => {
    const user  = _getUser(socket.id);
    const room  = Store.rooms.get(groupId);
    if (!user || !room || room.type !== "group") return;
    if (room.creatorId !== user.id && !user.isAdmin) {
      socket.emit("permission_denied", { message: "Только создатель группы может добавлять участников" }); return;
    }
    const tSid  = Store.userIndex.get(targetUserId);
    const tSock = tSid ? io.sockets.sockets.get(tSid) : null;
    if (!tSock) { socket.emit("error_event", { message: "Пользователь офлайн" }); return; }
    joinRoom(tSock, groupId);
    tSock.emit("added_to_group", { room: { id: groupId, type: "group", name: room.name }, by: publicUser(user) });
    tSock.emit("room_history", { roomId: groupId, messages: room.history });
    io.to(groupId).emit("group_member_joined", { groupId, user: publicUser(_getUser(tSid)) });
    socket.emit("group_updated", { groupId, action: "added", username: _getUser(tSid)?.username });
  });

  // УДАЛИТЬ ИЗ ГРУППЫ
  socket.on("kick_from_group", ({ groupId, targetUserId }) => {
    const user  = _getUser(socket.id);
    const room  = Store.rooms.get(groupId);
    if (!user || !room || room.type !== "group") return;
    if (room.creatorId !== user.id && !user.isAdmin) {
      socket.emit("permission_denied", { message: "Только создатель группы может удалять участников" }); return;
    }
    if (targetUserId === user.id) { socket.emit("error_event", { message: "Нельзя удалить себя" }); return; }
    const tSid  = Store.userIndex.get(targetUserId);
    const tSock = tSid ? io.sockets.sockets.get(tSid) : null;
    if (tSock) {
      tSock.leave(groupId);
      room.members.delete(tSid);
      tSock.emit("kicked_from_group", { groupId, groupName: room.name });
    }
    io.to(groupId).emit("group_member_left", { groupId, userId: targetUserId });
    socket.emit("group_updated", { groupId, action: "kicked", username: _getUser(tSid)?.username });
  });

  // ПОКИНУТЬ ГРУППУ
  socket.on("leave_group", ({ groupId }) => {
    const user = _getUser(socket.id);
    const room = Store.rooms.get(groupId);
    if (!user || !room) return;
    socket.leave(groupId);
    room.members.delete(socket.id);
    io.to(groupId).emit("group_member_left", { groupId, userId: user.id });
    socket.emit("left_group", { groupId });
  });

  // ПОЛУЧИТЬ УЧАСТНИКОВ ГРУППЫ
  socket.on("get_group_members", ({ groupId }) => {
    const room = Store.rooms.get(groupId);
    if (!room) return;
    const members = [];
    room.members.forEach(sid => {
      const u = _getUser(sid);
      if (u) members.push(publicUser(u));
    });
    socket.emit("group_members", { groupId, members });
  });

  // TYPING
  socket.on("typing_start", ({ roomId }) => {
    const user = _getUser(socket.id);
    const room = Store.rooms.get(roomId);
    if (!user || !room) return;
    if (!Store.typing.has(roomId)) Store.typing.set(roomId, new Map());
    const rt = Store.typing.get(roomId);
    if (rt.has(user.id)) clearTimeout(rt.get(user.id));
    socket.to(roomId).emit("user_typing", { userId: user.id, username: user.username, roomId });
    rt.set(user.id, setTimeout(() => clearTyping(roomId, user.id, socket), TYPING_EXPIRE));
  });

  socket.on("typing_stop", ({ roomId }) => {
    const user = _getUser(socket.id);
    if (user) clearTyping(roomId, user.id, socket);
  });

  socket.on("ping_server", () => socket.emit("pong_server", { ts: Date.now() }));

  socket.on("disconnect", () => {
    const user = _getUser(socket.id);
    if (!user) return;
    Store.userIndex.delete(user.id);
    Store.sessions.delete(socket.id);
    Store.rooms.forEach(r => r.members.delete(socket.id));
    db.prepare("UPDATE accounts SET last_seen = ? WHERE id = ?").run(Date.now(), user.id);
    io.emit("user_left", { userId: user.id, username: user.username });
  });
});

// ── HELPERS ──────────────────────────────────────────────────
function _loginSocket(socket, account, isNew = false) {
  // Считаем кол-во аккаунтов для определения первого admin
  const count   = db.prepare("SELECT COUNT(*) as c FROM accounts").get().c;
  const isAdmin = count <= 1;

  const user = {
    id:          account.id,
    socketId:    socket.id,
    username:    account.username,
    friendId:    account.friend_id,
    bio:         account.bio || "",
    avatar:      account.username.slice(0, 2).toUpperCase(),
    avatarUrl:   account.avatar_url   || null,
    avatarColor: account.avatar_color || null,
    isAdmin,
    online:      true,
    lastSeen:    account.last_seen,
    theme:       account.theme || "dark",
    story:       null,
  };

  Store.sessions.set(socket.id, { userId: user.id });
  Store.userIndex.set(user.id, socket.id);
  joinRoom(socket, "global");

  socket.emit("auth_success", {
    user: publicUser(user),
    rooms: getRooms(),
    users: getOnlineUsers(),
  });
  socket.broadcast.emit("user_joined", { user: publicUser(user) });

  // Сохраняем в оперативку для быстрого доступа
  Store.sessions.set(socket.id, user);
}

function _getUser(socketId) {
  return Store.sessions.get(socketId) || null;
}

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
  return {
    id: u.id, username: u.username, friendId: u.friendId,
    avatar: u.avatar, avatarUrl: u.avatarUrl, avatarColor: u.avatarColor,
    bio: u.bio, isAdmin: u.isAdmin, online: u.online,
    lastSeen: u.lastSeen, story: u.story,
  };
}

function getRooms() {
  const r = [];
  Store.rooms.forEach(room => {
    if (room.type !== "dm") r.push({ id: room.id, type: room.type, name: room.name, count: room.members.size, description: room.description || "" });
  });
  return r;
}

function getOnlineUsers() {
  const r = [];
  Store.sessions.forEach(u => { if (u && u.id) r.push(publicUser(u)); });
  return r;
}

function _hash(str) {
  return crypto.createHash("sha256").update(str + "markos_salt_v1").digest("hex");
}

function _genFriendId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "MARK-";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  // Проверяем уникальность
  const exists = db.prepare("SELECT id FROM accounts WHERE friend_id = ?").get(id);
  return exists ? _genFriendId() : id;
}

initRooms();
server.listen(PORT, () => console.log(`\n  🚀 MARK OS v4.0 на порту ${PORT}\n`));
module.exports = { server, io, Store, db };
