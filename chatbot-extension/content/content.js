// content.js — Виджет чата AI Customer Support

(function() {
  // Проверяем, не загружен ли уже виджет
  if (window.AIChatbotLoaded) return;
  window.AIChatbotLoaded = true;

  // Состояние
  let state = {
    isOpen: false,
    messages: [],
    siteData: null,
    settings: null,
    widget: null,
    usage: null,
    isLoading: false
  };

  // Rate limiting: минимальный интервал между сообщениями (мс)
  const MIN_MESSAGE_INTERVAL = 1000;
  let lastMessageTime = 0;

  // Лимиты и настройки
  const FREE_MESSAGE_LIMIT = 50;
  const MAX_HISTORY_LENGTH = 100;
  const ERROR_DISPLAY_TIME = 5000; // 5 секунд
  const MAX_RECENT_MESSAGES = 10; // Для отправки в API

  // DOM элементы
  let elements = {
    container: null,
    button: null,
    window: null,
    messages: null,
    input: null,
    sendBtn: null
  };

  // Инициализация
  async function init() {
    await loadData();

    // Если нет API ключа или сайт не обучен — не показываем виджет
    if (!state.settings?.apiKey) {
      // API ключ не настроен — не показываем виджет
      return;
    }

    createWidget();
    setupEventListeners();
    loadChatHistory();
  }

  // Загрузка данных из storage
  async function loadData() {
    try {
      const domain = window.location.hostname;
      const data = await chrome.storage.local.get([
        'settings',
        'usage',
        'widget',
        `site:${domain}`,
        `history:${domain}`
      ]);

      state.settings = data.settings || {};
      state.usage = data.usage || { messagesThisMonth: 0, monthStart: '' };
      state.widget = data.widget || {
        color: '#4F46E5',
        position: 'bottom-right',
        botName: 'Помощник',
        avatar: null,
        greeting: 'Привет! Чем могу помочь?'
      };
      state.siteData = data[`site:${domain}`] || null;
      state.messages = data[`history:${domain}`] || [];
    } catch (e) {
      console.error('[AI Chatbot] Ошибка загрузки данных:', e);
    }
  }

  // Создание виджета
  function createWidget() {
    const positionClass = `position-${state.widget.position || 'bottom-right'}`;
    const color = state.widget.color || '#4F46E5';

    const container = document.createElement('div');
    container.id = 'ai-chatbot-widget';
    container.className = positionClass;
    container.style.setProperty('--widget-color', color);
    container.style.setProperty('--widget-color-hover', adjustColor(color, -20));
    container.style.setProperty('--widget-color-light', `${color}1a`);

    container.innerHTML = `
      <button class="chat-button" aria-label="Открыть чат">
        <span class="chat-button-icon"></span>
      </button>
      <div class="chat-window">
        <div class="chat-header">
          <div class="chat-avatar">
            ${getSafeAvatarHtml(state.widget.avatar)}
          </div>
          <div class="chat-header-info">
            <div class="chat-header-name">${escapeHtml(state.widget.botName || 'Помощник')}</div>
            <div class="chat-header-status">Онлайн</div>
          </div>
          <button class="chat-close" aria-label="Закрыть">✕</button>
        </div>
        <div class="chat-messages"></div>
        <div class="chat-input-container">
          <textarea
            class="chat-input"
            placeholder="Напишите сообщение..."
            rows="1"
          ></textarea>
          <button class="chat-send" aria-label="Отправить">
            <span class="chat-send-icon">➤</span>
          </button>
        </div>
        <div class="chat-footer">
          Powered by AI Chatbot
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // Сохраняем ссылки на элементы
    elements.container = container;
    elements.button = container.querySelector('.chat-button');
    elements.window = container.querySelector('.chat-window');
    elements.messages = container.querySelector('.chat-messages');
    elements.input = container.querySelector('.chat-input');
    elements.sendBtn = container.querySelector('.chat-send');
  }

  // Настройка обработчиков событий
  function setupEventListeners() {
    // Открытие/закрытие чата
    elements.button.addEventListener('click', toggleChat);
    elements.container.querySelector('.chat-close').addEventListener('click', toggleChat);

    // Отправка сообщения
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Автоматическое изменение высоты textarea
    elements.input.addEventListener('input', () => {
      elements.input.style.height = 'auto';
      elements.input.style.height = Math.min(elements.input.scrollHeight, 100) + 'px';
    });

    // Слушаем сообщения от popup и background
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  // Переключение чата
  function toggleChat() {
    state.isOpen = !state.isOpen;
    elements.button.classList.toggle('open', state.isOpen);
    elements.window.classList.toggle('open', state.isOpen);

    if (state.isOpen) {
      elements.input.focus();

      // Показываем приветствие или историю
      if (state.messages.length === 0 && state.siteData) {
        showGreeting();
      } else if (!state.siteData) {
        showNotTrained();
      }
    }
  }

  // Показать приветствие
  function showGreeting() {
    const greeting = state.widget.greeting || 'Привет! Чем могу помочь?';
    addMessage('assistant', greeting);
  }

  // Показать сообщение что сайт не обучен
  function showNotTrained() {
    elements.messages.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">📚</div>
        <div class="chat-welcome-text">
          Этот сайт ещё не обучен.<br>
          Откройте расширение и нажмите<br>
          "Обучить на этом сайте"
        </div>
      </div>
    `;
    elements.input.disabled = true;
    elements.sendBtn.disabled = true;
  }

  // Загрузка истории чата
  function loadChatHistory() {
    if (state.messages.length > 0) {
      state.messages.forEach(msg => {
        renderMessage(msg.role, msg.text, msg.time, false);
      });
      scrollToBottom();
    }
  }

  // Добавление сообщения
  function addMessage(role, text) {
    const message = {
      role,
      text,
      time: new Date().toISOString()
    };

    state.messages.push(message);
    renderMessage(role, text, message.time);
    saveMessageToHistory(message);
    scrollToBottom();
  }

  // Рендер сообщения
  function renderMessage(role, text, time, animate = true) {
    const timeStr = new Date(time).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });

    const avatar = role === 'assistant'
      ? getSafeAvatarHtml(state.widget.avatar)
      : '👤';

    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;
    if (!animate) messageEl.style.animation = 'none';

    messageEl.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">
        <div class="message-bubble">${escapeHtml(text)}</div>
        <div class="message-time">${timeStr}</div>
      </div>
    `;

    // Убираем typing indicator если есть
    const typing = elements.messages.querySelector('.message.typing');
    if (typing) typing.remove();

    elements.messages.appendChild(messageEl);
  }

  // Показать typing indicator
  function showTyping() {
    const typingEl = document.createElement('div');
    typingEl.className = 'message assistant typing';
    typingEl.innerHTML = `
      <div class="message-avatar">${getSafeAvatarHtml(state.widget.avatar)}</div>
      <div class="message-content">
        <div class="message-bubble">
          <div class="typing-indicator">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
        </div>
      </div>
    `;
    elements.messages.appendChild(typingEl);
    scrollToBottom();
  }

  // Скролл вниз
  function scrollToBottom() {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  /**
   * Отправляет сообщение пользователя и получает ответ AI
   * Включает проверку rate limiting и лимитов сообщений
   */
  async function sendMessage() {
    const text = elements.input.value.trim();
    if (!text || state.isLoading) return;

    // Rate limiting: защита от спама
    const now = Date.now();
    if (now - lastMessageTime < MIN_MESSAGE_INTERVAL) {
      showError('Подождите немного перед следующим сообщением');
      return;
    }
    lastMessageTime = now;

    // Проверяем есть ли сайт
    if (!state.siteData) {
      showNotTrained();
      return;
    }

    // Проверяем лимиты
    const isPro = state.settings.plan === 'pro';
    const messageLimit = isPro ? Infinity : FREE_MESSAGE_LIMIT;

    // Проверяем и сбрасываем счётчик если новый месяц
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (state.usage.monthStart !== currentMonth) {
      state.usage.messagesThisMonth = 0;
      state.usage.monthStart = currentMonth;
    }

    if (state.usage.messagesThisMonth >= messageLimit) {
      showError(`Достигнут лимит сообщений (${messageLimit}/месяц). Перейдите на Pro для безлимита.`);
      return;
    }

    // Добавляем сообщение пользователя
    addMessage('user', text);
    elements.input.value = '';
    elements.input.style.height = 'auto';

    // Показываем typing
    state.isLoading = true;
    elements.sendBtn.disabled = true;
    showTyping();

    try {
      // Отправляем запрос через background script
      // Оптимизация: передаём siteId вместо полного контента (50KB)
      // Service Worker получит контент из storage/кэша
      const response = await chrome.runtime.sendMessage({
        action: 'sendChatMessage',
        message: text,
        siteName: state.siteData.title || window.location.hostname,
        siteId: `site:${window.location.hostname}`,
        history: state.messages.slice(-MAX_RECENT_MESSAGES)
      });

      if (response.success) {
        addMessage('assistant', response.message);

        // Инкрементируем счётчик
        state.usage.messagesThisMonth++;
        await chrome.storage.local.set({ usage: state.usage });
      } else {
        throw new Error(response.error || 'Ошибка получения ответа');
      }
    } catch (error) {
      console.error('[AI Chatbot] Ошибка:', error);
      showError(error.message || 'Произошла ошибка. Попробуйте позже.');

      // Убираем typing
      const typing = elements.messages.querySelector('.message.typing');
      if (typing) typing.remove();
    } finally {
      state.isLoading = false;
      elements.sendBtn.disabled = false;
    }
  }

  // Показать ошибку
  function showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'chat-error';
    errorEl.textContent = message;
    elements.messages.appendChild(errorEl);
    scrollToBottom();

    setTimeout(() => {
      errorEl.remove();
    }, ERROR_DISPLAY_TIME);
  }

  // Сохранение сообщения в историю (только Pro)
  async function saveMessageToHistory(message) {
    if (state.settings.plan !== 'pro') return;

    try {
      const domain = window.location.hostname;
      const key = `history:${domain}`;
      const history = state.messages.slice(-MAX_HISTORY_LENGTH); // Ограничиваем 100 сообщениями
      await chrome.storage.local.set({ [key]: history });
    } catch (e) {
      console.error('[AI Chatbot] Ошибка сохранения истории:', e);
    }
  }

  // Обработка сообщений от popup/background
  function handleMessage(message, sender, sendResponse) {
    switch (message.action) {
      case 'startParsing':
        handleParsing(message.maxPages).then(sendResponse);
        return true; // Асинхронный ответ

      case 'updateWidgetSettings':
        updateWidgetSettings(message.settings);
        sendResponse({ success: true });
        break;

      case 'ping':
        sendResponse({ success: true });
        break;
    }
  }

  /**
   * Обрабатывает парсинг сайта
   * @param {number} maxPages - Максимальное количество страниц для парсинга
   * @returns {Promise<{success: boolean, title?: string, content?: string, pagesCount?: number, error?: string}>}
   */
  async function handleParsing(maxPages) {
    try {
      // Загружаем parser.js если ещё не загружен
      if (!window.AIChatbotParser) {
        await loadParserScript();
      }

      const result = await window.AIChatbotParser.parseSite(maxPages, (current, total) => {
        // Отправляем прогресс в popup
        chrome.runtime.sendMessage({
          action: 'parsingProgress',
          current,
          total
        });
      });

      return {
        success: true,
        title: result.title,
        content: result.content,
        pagesCount: result.pagesCount
      };
    } catch (error) {
      console.error('[AI Chatbot] Ошибка парсинга:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Загрузка скрипта парсера
  function loadParserScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/parser.js');
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Обновление настроек виджета
  function updateWidgetSettings(settings) {
    state.widget = { ...state.widget, ...settings };

    if (elements.container) {
      // Обновляем цвет
      elements.container.style.setProperty('--widget-color', settings.color);
      elements.container.style.setProperty('--widget-color-hover', adjustColor(settings.color, -20));

      // Обновляем позицию
      elements.container.className = `position-${settings.position}`;

      // Обновляем название бота
      const nameEl = elements.container.querySelector('.chat-header-name');
      if (nameEl) nameEl.textContent = settings.botName;

      // Обновляем аватар
      const avatarEl = elements.container.querySelector('.chat-avatar');
      if (avatarEl) {
        avatarEl.innerHTML = getSafeAvatarHtml(settings.avatar);
      }
    }
  }

  /**
   * Экранирует HTML символы для предотвращения XSS
   * @param {string} text - Текст для экранирования
   * @returns {string} Экранированный текст
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }


  /**
   * Проверяет валидность URL изображения (защита от XSS)
   * @param {string} url - URL для проверки
   * @returns {boolean} true если URL валидный
   */
  function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      // Разрешаем только безопасные протоколы
      return ['http:', 'https:', 'data:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Создаёт безопасный HTML для аватара
   * @param {string} avatarUrl - URL аватара
   * @param {string} [fallbackEmoji='🤖'] - Fallback emoji если URL невалидный
   * @returns {string} HTML строка для аватара
   */
  function getSafeAvatarHtml(avatarUrl, fallbackEmoji = '🤖') {
    if (isValidImageUrl(avatarUrl)) {
      return `<img src="${escapeHtml(avatarUrl)}" alt="Avatar">`;
    }
    return fallbackEmoji;
  }

  function adjustColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return '#' + (0x1000000 +
      (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
      (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 +
      (B < 255 ? (B < 1 ? 0 : B) : 255)
    ).toString(16).slice(1);
  }

  // Запуск
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
