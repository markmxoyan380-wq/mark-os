/**
 * ============================================================
 * MARK OS — Frontend Engine
 * ============================================================
 * Архитектура:
 *   1. StateManager  — Redux-подобный менеджер состояния
 *   2. SocketEngine  — обёртка над Socket.io клиентом
 *   3. UIComponents  — рендер-функции компонентов
 *   4. AppController — точка входа, связывает всё вместе
 * ============================================================
 */

// ============================================================
//  БЛОК 1: STATE MANAGER — аналог Redux на чистом JS
// ============================================================

/**
 * Фабрика создания StateManager.
 * Хранит всё состояние приложения в одном месте.
 * Подписчики оповещаются только если изменился нужный срез.
 *
 * @param {Object} initialState — начальное состояние
 * @returns {Object} — { getState, dispatch, subscribe }
 */
function createStateManager(initialState) {
  let state = { ...initialState };
  // Массив подписчиков: { key: string|null, handler: fn }
  const subscribers = [];

  /**
   * Возвращает текущее состояние или его срез.
   * @param {string?} key — ключ среза (если не указан — всё состояние)
   */
  function getState(key) {
    return key ? state[key] : state;
  }

  /**
   * Обновляет состояние и уведомляет подписчиков.
   * @param {string} key    — ключ обновляемого среза
   * @param {*} updater     — новое значение или функция (prevVal) => newVal
   */
  function dispatch(key, updater) {
    const prevVal = state[key];
    const newVal  = typeof updater === 'function' ? updater(prevVal) : updater;

    // Shallow comparison — не обновляем если ничего не изменилось
    if (prevVal === newVal) return;

    state = { ...state, [key]: newVal };

    // Оповещаем подписчиков этого ключа и глобальных
    subscribers.forEach(({ key: subKey, handler }) => {
      if (subKey === null || subKey === key) {
        handler(newVal, prevVal, key);
      }
    });
  }

  /**
   * Подписка на изменение среза состояния.
   * @param {string|null} key   — ключ среза (null = любые изменения)
   * @param {Function} handler  — (newVal, prevVal, key) => void
   * @returns {Function} unsubscribe
   */
  function subscribe(key, handler) {
    const entry = { key, handler };
    subscribers.push(entry);
    return () => {
      const idx = subscribers.indexOf(entry);
      if (idx !== -1) subscribers.splice(idx, 1);
    };
  }

  return { getState, dispatch, subscribe };
}

// ─── Инициализация глобального состояния приложения ─────────
const State = createStateManager({
  /** Данные текущего авторизованного пользователя */
  currentUser: null,

  /** Map<roomId, Room> — все доступные комнаты */
  rooms: new Map(),

  /** Map<userId, User> — все онлайн-пользователи */
  users: new Map(),

  /** Map<roomId, Message[]> — история сообщений по комнатам */
  messages: new Map(),

  /** ID текущей активной комнаты */
  activeRoomId: 'global',

  /**
   * Set<userId> — пользователи, набирающие текст
   * в активной комнате
   */
  typingUsers: new Set(),

  /** 'login' | 'chat' — экран приложения */
  screen: 'login',

  /** Статус соединения: 'connecting' | 'connected' | 'disconnected' */
  connectionStatus: 'connecting',

  /** Флаг «пользователь прокрутил вверх» */
  userScrolledUp: false,
});

// ============================================================
//  БЛОК 2: SOCKET ENGINE — клиентская работа с Socket.io
// ============================================================

/**
 * SocketEngine — инкапсулирует все операции с сокетом.
 * Переводит сырые события в изменения State.
 */
const SocketEngine = (function () {
  let socket = null;

  /**
   * Инициализация подключения к серверу.
   * Вызывается один раз после ввода имени пользователя.
   */
  function connect() {
    // Подключаемся к тому же хосту
    socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    _bindEvents();
    return socket;
  }

  /**
   * Привязка всех серверных событий к State.
   * Каждый обработчик — чистая функция, обновляющая State.
   */
  function _bindEvents() {
    // ── Подключение / отключение ─────────────────────────
    socket.on('connect', () => {
      State.dispatch('connectionStatus', 'connected');
      UI.showToast('Соединение установлено', 'success');
    });

    socket.on('disconnect', () => {
      State.dispatch('connectionStatus', 'disconnected');
      UI.showToast('Соединение потеряно. Переподключение...', 'error');
    });

    socket.on('connect_error', () => {
      State.dispatch('connectionStatus', 'disconnected');
    });

    // ── Успешная авторизация ─────────────────────────────
    socket.on('auth_success', ({ user, rooms, users }) => {
      State.dispatch('currentUser', user);

      // Заполняем комнаты
      const roomMap = new Map();
      rooms.forEach(r => roomMap.set(r.id, r));
      State.dispatch('rooms', roomMap);

      // Заполняем пользователей
      const userMap = new Map();
      users.forEach(u => userMap.set(u.id, u));
      State.dispatch('users', userMap);

      // Переключаем на экран чата
      State.dispatch('screen', 'chat');

      // Запрашиваем историю глобальной комнаты
      socket.emit('join_room', { roomId: 'global' });
    });

    socket.on('auth_error', ({ message }) => {
      UI.showToast(message, 'error');
    });

    // ── Новое сообщение ──────────────────────────────────
    socket.on('new_message', (message) => {
      _addMessageToState(message);

      // Звуковой пинг для DM (если не активная комната)
      if (message.roomId !== State.getState('activeRoomId')) {
        UI.markRoomUnread(message.roomId);
        if (message.roomId.startsWith('dm_')) {
          UI.playNotificationSound();
        }
      }
    });

    // ── История комнаты ──────────────────────────────────
    socket.on('room_history', ({ roomId, messages }) => {
      State.dispatch('messages', prev => {
        const next = new Map(prev);
        next.set(roomId, messages);
        return next;
      });
    });

    // ── Новый пользователь вошёл ─────────────────────────
    socket.on('user_joined', ({ user }) => {
      State.dispatch('users', prev => {
        const next = new Map(prev);
        next.set(user.id, user);
        return next;
      });
      UI.showToast(`${user.username} присоединился`, 'info');
    });

    // ── Пользователь ушёл ────────────────────────────────
    socket.on('user_left', ({ userId, username }) => {
      State.dispatch('users', prev => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
      UI.showToast(`${username} вышел`, 'info');
    });

    // ── DM создан (инициатор) ─────────────────────────────
    socket.on('dm_ready', ({ room, history, partner }) => {
      // Добавляем комнату в State
      State.dispatch('rooms', prev => {
        const next = new Map(prev);
        next.set(room.id, room);
        return next;
      });
      // Сохраняем историю
      State.dispatch('messages', prev => {
        const next = new Map(prev);
        next.set(room.id, history);
        return next;
      });
      // Переключаемся на DM
      AppController.switchRoom(room.id);
    });

    // ── Входящий DM (получатель) ─────────────────────────
    socket.on('dm_incoming', ({ room, from }) => {
      State.dispatch('rooms', prev => {
        const next = new Map(prev);
        next.set(room.id, room);
        return next;
      });
      UI.showToast(`💬 Новое сообщение от ${from.username}`, 'dm');
      UI.renderRoomList();
    });

    // ── Индикатор набора ──────────────────────────────────
    socket.on('user_typing', ({ userId, username, roomId }) => {
      if (roomId !== State.getState('activeRoomId')) return;

      State.dispatch('typingUsers', prev => {
        const next = new Set(prev);
        next.add(userId);
        return next;
      });
      UI.renderTypingIndicator();
    });

    socket.on('typing_stopped', ({ userId, roomId }) => {
      if (roomId !== State.getState('activeRoomId')) return;

      State.dispatch('typingUsers', prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      UI.renderTypingIndicator();
    });

    // ── Ошибки ────────────────────────────────────────────
    socket.on('error_event', ({ message }) => {
      UI.showToast(message, 'error');
    });

    socket.on('permission_denied', ({ message }) => {
      UI.showToast('🚫 ' + message, 'error');
    });

    socket.on('pong_server', ({ ts }) => {
      const latency = Date.now() - ts;
      UI.updateLatency(latency);
    });
  }

  /**
   * Добавляет сообщение в Map сообщений State.
   * Поддерживает кольцевой буфер (макс. 500 на фронте).
   * @param {Object} message
   */
  function _addMessageToState(message) {
    State.dispatch('messages', prev => {
      const next = new Map(prev);
      const list = next.get(message.roomId) || [];
      const newList = [...list, message];
      // Обрезаем если слишком длинно
      next.set(message.roomId, newList.slice(-500));
      return next;
    });
  }

  /** Отправка авторизации */
  function auth(username) {
    if (!socket) return;
    socket.emit('auth', { username });
  }

  /** Отправка сообщения */
  function sendMessage(roomId, text) {
    if (!socket) return;
    socket.emit('send_message', { roomId, text });
  }

  /** Переключение комнаты */
  function joinRoom(roomId) {
    if (!socket) return;
    socket.emit('join_room', { roomId });
  }

  /** Открытие DM */
  function openDM(targetUserId) {
    if (!socket) return;
    socket.emit('open_dm', { targetUserId });
  }

  /** Начало набора */
  function typingStart(roomId) {
    if (!socket) return;
    socket.emit('typing_start', { roomId });
  }

  /** Конец набора */
  function typingStop(roomId) {
    if (!socket) return;
    socket.emit('typing_stop', { roomId });
  }

  /** Пинг-измерение задержки */
  function ping() {
    if (!socket) return;
    socket.emit('ping_server');
  }

  return { connect, auth, sendMessage, joinRoom, openDM, typingStart, typingStop, ping };
})();

// ============================================================
//  БЛОК 3: UI COMPONENTS — рендер-функции
// ============================================================

/**
 * UI — модуль всех операций с DOM.
 * Все методы работают через документ-кэш элементов.
 * Никаких innerHTML в циклах — только точечные обновления.
 */
const UI = (function () {
  // ─── Кэш DOM-элементов ───────────────────────────────────
  const $ = {};

  /** Инициализация кэша после загрузки DOM */
  function init() {
    $.loginScreen    = document.getElementById('login-screen');
    $.chatScreen     = document.getElementById('chat-screen');
    $.loginForm      = document.getElementById('login-form');
    $.usernameInput  = document.getElementById('username-input');
    $.loginBtn       = document.getElementById('login-btn');

    $.roomList       = document.getElementById('room-list');
    $.userList       = document.getElementById('user-list');
    $.messageList    = document.getElementById('message-list');
    $.messageInput   = document.getElementById('message-input');
    $.sendBtn        = document.getElementById('send-btn');
    $.roomTitle      = document.getElementById('room-title');
    $.roomSubtitle   = document.getElementById('room-subtitle');
    $.typingIndicator = document.getElementById('typing-indicator');
    $.toastContainer = document.getElementById('toast-container');
    $.statusDot      = document.getElementById('status-dot');
    $.latencyDisplay = document.getElementById('latency');
    $.onlineCount    = document.getElementById('online-count');
    $.channelBadge   = document.getElementById('channel-badge');
    $.sidebarToggle  = document.getElementById('sidebar-toggle');
    $.sidebar        = document.getElementById('sidebar');
    $.membersSidebar = document.getElementById('members-sidebar');
    $.membersToggle  = document.getElementById('members-toggle');

    _bindScrollListener();
    _bindInputListeners();
  }

  /**
   * Переключение между экранами login / chat.
   */
  function switchScreen(screen) {
    if (screen === 'chat') {
      $.loginScreen.classList.add('hidden');
      $.chatScreen.classList.remove('hidden');
      $.chatScreen.classList.add('fade-in');
    } else {
      $.loginScreen.classList.remove('hidden');
      $.chatScreen.classList.add('hidden');
    }
  }

  /**
   * Рендер списка комнат в сайдбаре.
   * Группирует по типу: global → channels → dm.
   */
  function renderRoomList() {
    const rooms       = State.getState('rooms');
    const activeRoomId = State.getState('activeRoomId');
    $.roomList.innerHTML = '';

    const sections = [
      { type: 'global',  label: 'Основное'   },
      { type: 'channel', label: 'Каналы'     },
      { type: 'dm',      label: 'Сообщения'  },
    ];

    sections.forEach(({ type, label }) => {
      const filtered = [];
      rooms.forEach(r => { if (r.type === type) filtered.push(r); });
      if (!filtered.length) return;

      // Секция-заголовок
      const section = document.createElement('div');
      section.className = 'room-section';
      section.innerHTML = `<span class="room-section-label">${label}</span>`;
      $.roomList.appendChild(section);

      // Элементы комнат
      filtered.forEach(room => {
        const el = document.createElement('div');
        el.className = 'room-item' + (room.id === activeRoomId ? ' active' : '');
        el.dataset.roomId = room.id;

        const icon = room.type === 'global'  ? '🌐'
                   : room.type === 'channel' ? '📢'
                   : '💬';

        el.innerHTML = `
          <span class="room-icon">${icon}</span>
          <span class="room-name">${escapeHTML(room.name)}</span>
          ${room._unread ? '<span class="unread-dot"></span>' : ''}
        `;

        el.addEventListener('click', () => {
          AppController.switchRoom(room.id);
        });

        $.roomList.appendChild(el);
      });
    });
  }

  /**
   * Рендер списка онлайн-пользователей.
   */
  function renderUserList() {
    const users       = State.getState('users');
    const currentUser = State.getState('currentUser');

    $.userList.innerHTML = '';
    $.onlineCount.textContent = users.size;

    users.forEach(user => {
      const isMe = currentUser && user.id === currentUser.id;
      const el   = document.createElement('div');
      el.className = 'user-item' + (isMe ? ' me' : '');
      el.dataset.userId = user.id;

      el.innerHTML = `
        <div class="user-avatar" style="background: ${stringToColor(user.username)}">
          ${escapeHTML(user.avatar || user.username.slice(0,2).toUpperCase())}
        </div>
        <div class="user-info">
          <span class="user-name">${escapeHTML(user.username)}${isMe ? ' (ты)' : ''}</span>
          ${user.isAdmin ? '<span class="admin-badge">ADMIN</span>' : ''}
        </div>
        <div class="user-online-dot"></div>
      `;

      // Клик на пользователя → открыть DM (не на себя)
      if (!isMe) {
        el.addEventListener('click', () => {
          SocketEngine.openDM(user.id);
        });
        el.title = `Написать ${user.username}`;
        el.style.cursor = 'pointer';
      }

      $.userList.appendChild(el);
    });
  }

  /**
   * Рендер сообщений активной комнаты.
   * Группирует последовательные сообщения одного автора.
   * «Умная» прокрутка: скролл вниз только если userScrolledUp = false.
   */
  function renderMessages() {
    const activeRoomId = State.getState('activeRoomId');
    const allMessages  = State.getState('messages');
    const messages     = allMessages.get(activeRoomId) || [];
    const currentUser  = State.getState('currentUser');

    $.messageList.innerHTML = '';

    let lastAuthorId = null;
    let lastTimestamp = 0;

    messages.forEach((msg, idx) => {
      const isMe      = currentUser && msg.authorId === currentUser.id;
      // Группировка: если тот же автор и меньше 5 минут — compact
      const sameAuthor = msg.authorId === lastAuthorId;
      const closeTime  = (msg.timestamp - lastTimestamp) < 5 * 60 * 1000;
      const isCompact  = sameAuthor && closeTime;

      const el = document.createElement('div');
      el.className = `message-wrapper ${isMe ? 'mine' : 'theirs'} ${isCompact ? 'compact' : ''}`;
      el.dataset.messageId = msg.id;

      const time = formatTime(msg.timestamp);

      if (!isCompact) {
        el.innerHTML = `
          <div class="msg-avatar" style="background: ${stringToColor(msg.author)}">
            ${escapeHTML(msg.avatar || msg.author.slice(0,2).toUpperCase())}
          </div>
          <div class="msg-body">
            <div class="msg-header">
              <span class="msg-author ${msg.isAdmin ? 'is-admin' : ''}">${escapeHTML(msg.author)}</span>
              ${msg.isAdmin ? '<span class="msg-admin-crown">👑</span>' : ''}
              <span class="msg-time">${time}</span>
            </div>
            <div class="msg-bubble">
              <p class="msg-text">${formatMessageText(msg.text)}</p>
            </div>
          </div>
        `;
      } else {
        // Компактный вид — без аватара и имени
        el.innerHTML = `
          <div class="msg-avatar-spacer"></div>
          <div class="msg-body">
            <div class="msg-bubble">
              <p class="msg-text">${formatMessageText(msg.text)}</p>
              <span class="msg-time-compact">${time}</span>
            </div>
          </div>
        `;
      }

      // Анимация появления только для последнего сообщения
      if (idx === messages.length - 1) {
        el.classList.add('msg-appear');
      }

      $.messageList.appendChild(el);

      lastAuthorId  = msg.authorId;
      lastTimestamp = msg.timestamp;
    });

    // Умный скролл
    if (!State.getState('userScrolledUp')) {
      scrollToBottom(false);
    } else {
      // Показываем кнопку «вниз»
      showScrollDownBtn();
    }
  }

  /**
   * Рендер индикатора набора текста.
   * Показывает имена пользователей, которые сейчас печатают.
   */
  function renderTypingIndicator() {
    const typingUsers = State.getState('typingUsers');
    const users       = State.getState('users');

    if (typingUsers.size === 0) {
      $.typingIndicator.classList.add('hidden');
      return;
    }

    const names = [];
    typingUsers.forEach(userId => {
      const u = users.get(userId);
      if (u) names.push(u.username);
    });

    let text = '';
    if (names.length === 1) text = `${names[0]} печатает`;
    else if (names.length === 2) text = `${names[0]} и ${names[1]} печатают`;
    else text = `${names.length} человека печатают`;

    $.typingIndicator.querySelector('.typing-text').textContent = text;
    $.typingIndicator.classList.remove('hidden');
  }

  /**
   * Обновление заголовка активной комнаты.
   * @param {Object} room
   */
  function updateRoomHeader(room) {
    if (!room) return;
    $.roomTitle.textContent = room.name;

    const typeLabels = {
      global:  '🌐 Общий чат · все участники',
      channel: '📢 Канал · только чтение',
      dm:      '💬 Личное сообщение',
    };
    $.roomSubtitle.textContent = typeLabels[room.type] || '';

    // Показываем badge для каналов (только admin может писать)
    const currentUser = State.getState('currentUser');
    if (room.type === 'channel' && (!currentUser || !currentUser.isAdmin)) {
      $.channelBadge.classList.remove('hidden');
      $.messageInput.disabled = true;
      $.messageInput.placeholder = 'Только администратор может писать в каналы';
      $.sendBtn.disabled = true;
    } else {
      $.channelBadge.classList.add('hidden');
      $.messageInput.disabled = false;
      $.messageInput.placeholder = 'Написать сообщение...';
      $.sendBtn.disabled = false;
    }
  }

  /**
   * Показ уведомления (Toast).
   * @param {string} message
   * @param {'success'|'error'|'info'|'dm'} type
   */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = { success: '✓', error: '✕', info: 'ℹ', dm: '💬' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ'}</span>
      <span class="toast-message">${escapeHTML(message)}</span>
    `;

    $.toastContainer.appendChild(toast);
    // Форс-рефлоу для запуска CSS-анимации
    toast.getBoundingClientRect();
    toast.classList.add('toast-visible');

    setTimeout(() => {
      toast.classList.remove('toast-visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 3500);
  }

  /**
   * Пометить комнату как «непрочитанную» в UI.
   * @param {string} roomId
   */
  function markRoomUnread(roomId) {
    const rooms = State.getState('rooms');
    const room  = rooms.get(roomId);
    if (room) {
      room._unread = true;
      renderRoomList();
    }
  }

  /**
   * Обновить отображение задержки в хедере.
   * @param {number} ms
   */
  function updateLatency(ms) {
    $.latencyDisplay.textContent = `${ms}ms`;
    $.latencyDisplay.className = ms < 100 ? 'latency good' : ms < 300 ? 'latency ok' : 'latency bad';
  }

  /** Обновление индикатора статуса соединения */
  function updateConnectionStatus(status) {
    $.statusDot.className = `status-dot status-${status}`;
    const labels = { connected: 'онлайн', connecting: 'подключение...', disconnected: 'офлайн' };
    $.statusDot.title = labels[status] || status;
  }

  /**
   * Прокрутка чата вниз.
   * @param {boolean} smooth — плавная или мгновенная
   */
  function scrollToBottom(smooth = true) {
    $.messageList.scrollTo({
      top:      $.messageList.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
  }

  /**
   * Показывает кнопку «↓ перейти вниз» когда пользователь прокрутил вверх.
   */
  function showScrollDownBtn() {
    let btn = document.getElementById('scroll-down-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'scroll-down-btn';
      btn.className = 'scroll-down-btn';
      btn.innerHTML = '↓';
      btn.addEventListener('click', () => {
        State.dispatch('userScrolledUp', false);
        scrollToBottom(true);
        btn.remove();
      });
      $.messageList.parentElement.appendChild(btn);
    }
  }

  /**
   * Звуковой сигнал уведомления (Web Audio API).
   * Простой синтетический «пинг».
   */
  function playNotificationSound() {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) { /* игнорируем если AudioContext недоступен */ }
  }

  // ─── ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ UI ────────────────

  /**
   * Слушатель прокрутки для «умного скролла».
   * Определяет, находится ли пользователь внизу.
   */
  function _bindScrollListener() {
    $.messageList.addEventListener('scroll', () => {
      const el        = $.messageList;
      const atBottom  = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      State.dispatch('userScrolledUp', !atBottom);

      if (atBottom) {
        const btn = document.getElementById('scroll-down-btn');
        if (btn) btn.remove();
      }
    });
  }

  /**
   * Привязка слушателей к инпуту сообщения.
   * Реализует throttle для события typing.
   */
  function _bindInputListeners() {
    let typingTimer   = null;
    let isTyping      = false;
    const THROTTLE_MS = 2000; // отправляем typing_start не чаще раза в 2с

    $.messageInput.addEventListener('input', () => {
      const roomId = State.getState('activeRoomId');
      if (!roomId) return;

      if (!isTyping) {
        SocketEngine.typingStart(roomId);
        isTyping = true;
      }

      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        SocketEngine.typingStop(roomId);
        isTyping = false;
      }, THROTTLE_MS);

      // Авторастяжение textarea
      $.messageInput.style.height = 'auto';
      $.messageInput.style.height = Math.min($.messageInput.scrollHeight, 150) + 'px';
    });

    // Отправка по Enter (Shift+Enter = новая строка)
    $.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        clearTimeout(typingTimer);
        isTyping = false;
        AppController.sendMessage();
      }
    });

    // Мобильный sidebar toggle
    if ($.sidebarToggle) {
      $.sidebarToggle.addEventListener('click', () => {
        $.sidebar.classList.toggle('open');
      });
    }

    if ($.membersToggle) {
      $.membersToggle.addEventListener('click', () => {
        $.membersSidebar.classList.toggle('open');
      });
    }
  }

  // ─── УТИЛИТЫ ─────────────────────────────────────────────

  /**
   * Экранирование HTML — защита от XSS.
   * @param {string} str
   * @returns {string}
   */
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Форматирование текста сообщения:
   * - экранирование XSS
   * - URL → кликабельные ссылки
   * - **bold** → <strong>
   * - `code` → <code>
   * @param {string} text
   * @returns {string} HTML-строка
   */
  function formatMessageText(text) {
    let escaped = escapeHTML(text);

    // URL → ссылки
    escaped = escaped.replace(
      /(https?:\/\/[^\s<>"']+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>'
    );

    // **bold**
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // `code`
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Новые строки
    escaped = escaped.replace(/\n/g, '<br>');

    return escaped;
  }

  /**
   * Форматирование метки времени.
   * @param {number} timestamp
   * @returns {string} '14:35' или 'вчера 14:35'
   */
  function formatTime(timestamp) {
    const date  = new Date(timestamp);
    const now   = new Date();
    const hours = String(date.getHours()).padStart(2, '0');
    const mins  = String(date.getMinutes()).padStart(2, '0');
    const time  = `${hours}:${mins}`;

    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return time;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `вчера ${time}`;

    return `${date.getDate()}.${date.getMonth()+1} ${time}`;
  }

  /**
   * Детерминированный цвет из строки (для аватаров).
   * Используется djb2 hash.
   * @param {string} str
   * @returns {string} hsl-цвет
   */
  function stringToColor(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 60%, 45%)`;
  }

  return {
    init,
    switchScreen,
    renderRoomList,
    renderUserList,
    renderMessages,
    renderTypingIndicator,
    updateRoomHeader,
    updateConnectionStatus,
    showToast,
    markRoomUnread,
    updateLatency,
    playNotificationSound,
    scrollToBottom,
    escapeHTML,
  };
})();

// ============================================================
//  БЛОК 4: APP CONTROLLER — точка входа, связывает всё
// ============================================================

/**
 * AppController — оркестратор приложения.
 * Инициализирует систему, подписывается на State и обрабатывает действия.
 */
const AppController = (function () {

  /**
   * Инициализация приложения после загрузки DOM.
   * Порядок:
   *   1. Init UI (кэш DOM-элементов)
   *   2. Bind UI actions (кнопки)
   *   3. Subscribe на State
   *   4. Connect Socket
   */
  function init() {
    UI.init();
    _bindUIActions();
    _subscribeToState();

    // Запуск периодического пинга для измерения задержки
    setInterval(() => {
      if (State.getState('screen') === 'chat') {
        SocketEngine.ping();
      }
    }, 5000);
  }

  /**
   * Привязка пользовательских действий к UI-элементам.
   */
  function _bindUIActions() {
    const loginBtn   = document.getElementById('login-btn');
    const sendBtn    = document.getElementById('send-btn');
    const usernameIn = document.getElementById('username-input');

    loginBtn.addEventListener('click', handleLogin);
    sendBtn.addEventListener('click', sendMessage);

    usernameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
  }

  /**
   * Подписки на изменения State → обновление UI.
   * Это «реактивная» связь State ↔ UI.
   */
  function _subscribeToState() {
    // Смена экрана
    State.subscribe('screen', (screen) => {
      UI.switchScreen(screen);
    });

    // Обновление комнат
    State.subscribe('rooms', () => {
      UI.renderRoomList();
    });

    // Обновление пользователей
    State.subscribe('users', () => {
      UI.renderUserList();
    });

    // Обновление сообщений
    State.subscribe('messages', () => {
      UI.renderMessages();
    });

    // Статус соединения
    State.subscribe('connectionStatus', (status) => {
      UI.updateConnectionStatus(status);
    });

    // Набор текста
    State.subscribe('typingUsers', () => {
      UI.renderTypingIndicator();
    });
  }

  /**
   * Обработчик входа в систему.
   * Подключается к сокету, отправляет auth.
   */
  function handleLogin() {
    const input    = document.getElementById('username-input');
    const username = (input.value || '').trim();

    if (username.length < 2) {
      UI.showToast('Имя должно содержать минимум 2 символа', 'error');
      input.classList.add('shake');
      input.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
      return;
    }

    const btn = document.getElementById('login-btn');
    btn.textContent = 'Подключение...';
    btn.disabled = true;

    SocketEngine.connect();

    // Слушаем успешное подключение сокета для отправки auth
    const checkReady = setInterval(() => {
      const status = State.getState('connectionStatus');
      if (status === 'connected') {
        clearInterval(checkReady);
        SocketEngine.auth(username);
        btn.textContent = 'Войти';
        btn.disabled = false;
      } else if (status === 'disconnected') {
        clearInterval(checkReady);
        UI.showToast('Не удалось подключиться к серверу', 'error');
        btn.textContent = 'Войти';
        btn.disabled = false;
      }
    }, 100);
  }

  /**
   * Отправка сообщения в активную комнату.
   */
  function sendMessage() {
    const input      = document.getElementById('message-input');
    const text       = (input.value || '').trim();
    const activeRoom = State.getState('activeRoomId');

    if (!text || !activeRoom) return;

    SocketEngine.sendMessage(activeRoom, text);

    // Очищаем инпут
    input.value = '';
    input.style.height = 'auto';
    input.focus();
  }

  /**
   * Переключение активной комнаты.
   * @param {string} roomId
   */
  function switchRoom(roomId) {
    const rooms = State.getState('rooms');
    const room  = rooms.get(roomId);
    if (!room) return;

    // Сбрасываем непрочитанное
    if (room._unread) {
      room._unread = false;
    }

    // Обновляем State
    State.dispatch('activeRoomId', roomId);
    State.dispatch('typingUsers', new Set());
    State.dispatch('userScrolledUp', false);

    // Обновляем UI хедер
    UI.updateRoomHeader(room);

    // Запрашиваем историю если ещё нет
    const messages = State.getState('messages');
    if (!messages.has(roomId)) {
      SocketEngine.joinRoom(roomId);
    } else {
      UI.renderMessages();
    }

    // Перерисовываем список комнат (убираем активный класс)
    UI.renderRoomList();

    // Закрываем мобильный сайдбар
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open');
  }

  return { init, handleLogin, sendMessage, switchRoom };
})();

// ─── ЗАПУСК ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  AppController.init();

  // Инициализация экрана из State
  UI.switchScreen(State.getState('screen'));
  UI.updateConnectionStatus(State.getState('connectionStatus'));

  // Анимация появления логин-экрана
  document.getElementById('login-screen').classList.add('fade-in');
});
