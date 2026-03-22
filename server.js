/**
 * ============================================================
 * MARK OS — Мессенджер. Серверное ядро.
 * ============================================================
 * Стек: Node.js + Socket.io + чистый JavaScript
 * Архитектура: Event-driven, модульная, in-memory хранилище
 * Автор: Senior Fullstack / Architect
 * ============================================================
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── КОНФИГ ─────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const MAX_HISTORY   = 100;   // максимум сообщений на комнату в памяти
const TYPING_EXPIRE = 4000;  // мс — после этого индикатор набора гасится

// ─── IN-MEMORY ХРАНИЛИЩЕ ────────────────────────────────────
/**
 * Центральное хранилище состояния сервера.
 * Всё в оперативной памяти — без БД, чтобы продемонстрировать
 * чистую архитектуру ядра. В продакшне сюда подключается Redis / Postgres.
 */
const Store = {
  /** Map<socketId, UserObject> — все подключённые пользователи */
  users: new Map(),

  /**
   * Map<roomId, RoomObject> — все комнаты.
   * RoomObject: { id, type, name, members: Set<socketId>, history: Message[] }
   * type: 'global' | 'channel' | 'dm'
   */
  rooms: new Map(),

  /** Map<userId, socketId> — быстрый обратный поиск сокета по userId */
  userIndex: new Map(),

  /** Map<roomId, Map<userId, timestamp>> — кто сейчас печатает */
  typing: new Map(),
};

// ─── ИНИЦИАЛИЗАЦИЯ СИСТЕМНЫХ КОМНАТ ─────────────────────────
/**
 * Создаём предопределённые комнаты при старте сервера.
 * 'global'  — общий чат, все могут писать.
 * 'channel' — каналы, только admin.
 * 'dm'      — создаются динамически при запросе.
 */
function initSystemRooms() {
  const systemRooms = [
    { id: 'global',       type: 'global',  name: '# Главный зал' },
    { id: 'ch_news',      type: 'channel', name: '📢 Новости'    },
    { id: 'ch_updates',   type: 'channel', name: '🔧 Обновления' },
  ];

  systemRooms.forEach(room => {
    Store.rooms.set(room.id, {
      id:      room.id,
      type:    room.type,
      name:    room.name,
      members: new Set(),
      history: [],
    });
  });

  console.log(`[Store] Инициализировано ${systemRooms.length} системных комнат.`);
}

// ─── HTTP СЕРВЕР (статика) ───────────────────────────────────
/**
 * Минималистичный HTTP-сервер для отдачи статических файлов
 * из папки /public. В продакшне это заменяется nginx/CDN.
 */
const server = http.createServer((req, res) => {
  // Убираем query-строку из URL (?v=123 и т.п.)
  const urlPath = req.url.split('?')[0];
  console.log('[HTTP]', req.method, urlPath);

  // Socket.io обрабатывает свои маршруты сам — пропускаем
  if (urlPath.startsWith('/socket.io')) return;

  const rootDir = __dirname;
  let filePath = path.join(rootDir, 'public',
    urlPath === '/' ? 'index.html' : urlPath
  );
  console.log('[PATH]', filePath);
  console.log('[PATH]', filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'text/javascript',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - file not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── SOCKET.IO ──────────────────────────────────────────────
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ============================================================
//  SOCKET HANDLERS — обработчики всех событий
// ============================================================

io.on('connection', (socket) => {
  console.log(`[Socket] Новое подключение: ${socket.id}`);

  // ── АВТОРИЗАЦИЯ / РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ ───────────────
  /**
   * Событие 'auth' — первый шаг после подключения.
   * Клиент передаёт { username, avatar? }.
   * Сервер присваивает UUID, флаг isAdmin (первый вошедший),
   * и отправляет полный снимок состояния системы.
   */
  socket.on('auth', ({ username, avatar }) => {
    if (!username || typeof username !== 'string') {
      socket.emit('auth_error', { message: 'Некорректное имя пользователя' });
      return;
    }

    const cleanName = username.trim().slice(0, 32);
    const userId    = uuidv4();
    const isAdmin   = Store.users.size === 0; // первый пользователь — admin

    const user = {
      id:       userId,
      socketId: socket.id,
      username: cleanName,
      avatar:   avatar || generateAvatar(cleanName),
      isAdmin,
      online:   true,
      joinedAt: Date.now(),
    };

    // Сохраняем пользователя в хранилище
    Store.users.set(socket.id, user);
    Store.userIndex.set(userId, socket.id);

    // Подключаем к глобальной комнате автоматически
    joinRoom(socket, 'global');

    // Отправляем клиенту его данные + полный снимок системы
    socket.emit('auth_success', {
      user,
      rooms:   getRoomsSnapshot(),
      users:   getUsersSnapshot(),
    });

    // Оповещаем остальных о новом пользователе
    socket.broadcast.emit('user_joined', { user });

    console.log(`[Auth] ${cleanName} (${userId}) авторизован. Admin: ${isAdmin}`);
  });

  // ── ОТПРАВКА СООБЩЕНИЯ ───────────────────────────────────
  /**
   * Событие 'send_message' — основной поток данных.
   * Payload: { roomId, text, type? }
   * Сервер валидирует права, создаёт объект сообщения,
   * сохраняет в историю и рассылает всем в комнате.
   */
  socket.on('send_message', ({ roomId, text }) => {
    const user = Store.users.get(socket.id);
    if (!user) { socket.emit('error_event', { message: 'Не авторизован' }); return; }

    const room = Store.rooms.get(roomId);
    if (!room) { socket.emit('error_event', { message: 'Комната не найдена' }); return; }

    const cleanText = (text || '').trim().slice(0, 4096);
    if (!cleanText) return;

    // ── ПРОВЕРКА ПРАВ: только admin пишет в каналы ──────────
    if (room.type === 'channel' && !user.isAdmin) {
      socket.emit('permission_denied', {
        message: 'Только администратор может писать в каналы',
      });
      return;
    }

    // ── ПРОВЕРКА DM: только участники комнаты ───────────────
    if (room.type === 'dm' && !room.members.has(socket.id)) {
      socket.emit('permission_denied', { message: 'Нет доступа к этой беседе' });
      return;
    }

    // Создаём объект сообщения
    const message = {
      id:        uuidv4(),
      roomId,
      authorId:  user.id,
      author:    user.username,
      avatar:    user.avatar,
      text:      cleanText,
      timestamp: Date.now(),
      isAdmin:   user.isAdmin,
    };

    // Сохраняем в историю комнаты (кольцевой буфер)
    room.history.push(message);
    if (room.history.length > MAX_HISTORY) {
      room.history.shift();
    }

    // Рассылаем сообщение всем в комнате
    io.to(roomId).emit('new_message', message);

    // Сбрасываем индикатор набора для этого пользователя
    clearTyping(roomId, user.id, socket);
  });

  // ── ПЕРЕКЛЮЧЕНИЕ КОМНАТЫ ─────────────────────────────────
  /**
   * Событие 'join_room' — клиент переключается на другую комнату.
   * Сервер добавляет сокет в Socket.io Room и отдаёт историю.
   */
  socket.on('join_room', ({ roomId }) => {
    const user = Store.users.get(socket.id);
    if (!user) return;

    const room = Store.rooms.get(roomId);
    if (!room) { socket.emit('error_event', { message: 'Комната не существует' }); return; }

    joinRoom(socket, roomId);

    // Отправляем историю сообщений
    socket.emit('room_history', {
      roomId,
      messages: room.history,
    });
  });

  // ── СОЗДАНИЕ DM КОМНАТЫ ──────────────────────────────────
  /**
   * Событие 'open_dm' — инициатор хочет написать targetUserId.
   * Сервер создаёт детерминированный ID комнаты (чтобы не дублировать),
   * добавляет обоих участников, уведомляет получателя.
   */
  socket.on('open_dm', ({ targetUserId }) => {
    const initiator = Store.users.get(socket.id);
    if (!initiator) return;

    if (initiator.id === targetUserId) {
      socket.emit('error_event', { message: 'Нельзя написать самому себе' });
      return;
    }

    const targetSocketId = Store.userIndex.get(targetUserId);
    const target = targetSocketId ? Store.users.get(targetSocketId) : null;

    if (!target) {
      socket.emit('error_event', { message: 'Пользователь офлайн или не найден' });
      return;
    }

    // Детерминированный roomId: сортировка ID гарантирует уникальность пары
    const dmRoomId = 'dm_' + [initiator.id, targetUserId].sort().join('_');

    // Создаём комнату если не существует
    if (!Store.rooms.has(dmRoomId)) {
      Store.rooms.set(dmRoomId, {
        id:      dmRoomId,
        type:    'dm',
        name:    `DM: ${initiator.username} ↔ ${target.username}`,
        members: new Set(),
        history: [],
      });
    }

    const dmRoom = Store.rooms.get(dmRoomId);

    // Подключаем обоих участников
    joinRoom(socket, dmRoomId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) joinRoom(targetSocket, dmRoomId);

    // Уведомляем инициатора
    socket.emit('dm_ready', {
      room:     { id: dmRoomId, type: 'dm', name: `💬 ${target.username}` },
      history:  dmRoom.history,
      partner:  target,
    });

    // Уведомляем получателя о входящем DM
    if (targetSocket) {
      targetSocket.emit('dm_incoming', {
        room:       { id: dmRoomId, type: 'dm', name: `💬 ${initiator.username}` },
        from:       initiator,
      });
    }
  });

  // ── ИНДИКАТОР НАБОРА ТЕКСТА ──────────────────────────────
  /**
   * Событие 'typing_start' — клиент начал печатать.
   * Троттлинг реализован на клиенте; сервер просто рассылает событие
   * и запускает таймер автоочистки.
   */
  socket.on('typing_start', ({ roomId }) => {
    const user = Store.users.get(socket.id);
    if (!user) return;

    const room = Store.rooms.get(roomId);
    if (!room) return;

    // Инициализируем Map для комнаты
    if (!Store.typing.has(roomId)) Store.typing.set(roomId, new Map());
    const roomTyping = Store.typing.get(roomId);

    // Очищаем предыдущий таймер если есть
    if (roomTyping.has(user.id)) {
      clearTimeout(roomTyping.get(user.id).timer);
    }

    // Уведомляем всех в комнате кроме отправителя
    socket.to(roomId).emit('user_typing', {
      userId:   user.id,
      username: user.username,
      roomId,
    });

    // Таймер автоматической очистки
    const timer = setTimeout(() => {
      clearTyping(roomId, user.id, socket);
    }, TYPING_EXPIRE);

    roomTyping.set(user.id, { timer });
  });

  /**
   * Событие 'typing_stop' — пользователь отправил сообщение
   * или удалил весь текст.
   */
  socket.on('typing_stop', ({ roomId }) => {
    const user = Store.users.get(socket.id);
    if (!user) return;
    clearTyping(roomId, user.id, socket);
  });

  // ── ЗАПРОС СПИСКА ПОЛЬЗОВАТЕЛЕЙ ─────────────────────────
  /**
   * Событие 'get_users' — клиент просит актуальный список онлайн.
   */
  socket.on('get_users', () => {
    socket.emit('users_list', { users: getUsersSnapshot() });
  });

  // ── ОТКЛЮЧЕНИЕ ──────────────────────────────────────────
  /**
   * Событие 'disconnect' — пользователь отключился.
   * Очищаем все связанные данные и уведомляем остальных.
   */
  socket.on('disconnect', () => {
    const user = Store.users.get(socket.id);
    if (!user) return;

    // Убираем из всех комнат
    Store.rooms.forEach(room => {
      room.members.delete(socket.id);
    });

    // Чистим индексы
    Store.userIndex.delete(user.id);
    Store.users.delete(socket.id);

    // Уведомляем всех
    io.emit('user_left', { userId: user.id, username: user.username });

    console.log(`[Socket] Отключился: ${user.username} (${socket.id})`);
  });

  // ── PING / HEARTBEAT ─────────────────────────────────────
  socket.on('ping_server', () => {
    socket.emit('pong_server', { ts: Date.now() });
  });
});

// ============================================================
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Server Utilities)
// ============================================================

/**
 * Подключает сокет к комнате Socket.io и добавляет в Store.
 * @param {Socket} socket
 * @param {string} roomId
 */
function joinRoom(socket, roomId) {
  socket.join(roomId);
  const room = Store.rooms.get(roomId);
  if (room) room.members.add(socket.id);
}

/**
 * Сбрасывает индикатор набора для пользователя в комнате.
 * Рассылает событие 'typing_stopped' всем в комнате.
 * @param {string} roomId
 * @param {string} userId
 * @param {Socket} socket
 */
function clearTyping(roomId, userId, socket) {
  const roomTyping = Store.typing.get(roomId);
  if (roomTyping && roomTyping.has(userId)) {
    clearTimeout(roomTyping.get(userId).timer);
    roomTyping.delete(userId);
  }
  socket.to(roomId).emit('typing_stopped', { userId, roomId });
}

/**
 * Возвращает снимок всех публичных комнат (без members Set).
 * @returns {Array}
 */
function getRoomsSnapshot() {
  const result = [];
  Store.rooms.forEach(room => {
    if (room.type !== 'dm') {
      result.push({
        id:      room.id,
        type:    room.type,
        name:    room.name,
        count:   room.members.size,
      });
    }
  });
  return result;
}

/**
 * Возвращает снимок всех онлайн-пользователей.
 * @returns {Array}
 */
function getUsersSnapshot() {
  const result = [];
  Store.users.forEach(user => {
    result.push({
      id:       user.id,
      username: user.username,
      avatar:   user.avatar,
      isAdmin:  user.isAdmin,
      online:   user.online,
    });
  });
  return result;
}

/**
 * Генерирует дефолтный аватар на основе инициалов имени.
 * Возвращает строку с эмодзи-«буквой» (просто CSS initials).
 * @param {string} name
 * @returns {string}
 */
function generateAvatar(name) {
  return name.slice(0, 2).toUpperCase();
}

// ─── СТАРТ СЕРВЕРА ───────────────────────────────────────────
initSystemRooms();

server.listen(PORT, () => {
  console.log('');
  console.log('  ███╗   ███╗ █████╗ ██████╗ ██╗  ██╗     ██████╗ ███████╗');
  console.log('  ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝    ██╔═══██╗██╔════╝');
  console.log('  ██╔████╔██║███████║██████╔╝█████╔╝     ██║   ██║███████╗');
  console.log('  ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗     ██║   ██║╚════██║');
  console.log('  ██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗    ╚██████╔╝███████║');
  console.log('  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═════╝ ╚══════╝');
  console.log('');
  console.log(`  🚀 MARK OS запущен на порту ${PORT}`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log('');
});

module.exports = { server, io, Store };
