// content.js — Виджет чата AI Customer Support (с встроенным парсером)

(function() {
  // Проверяем, не загружен ли уже виджет
  if (window.AIChatbotLoaded) return;
  window.AIChatbotLoaded = true;

  // ==================== ПАРСЕР (встроенный) ====================

  const EXCLUDE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'video', 'audio',
    'nav', 'footer', 'header', '.nav', '.navigation', '.menu', '.footer', '.header',
    '.sidebar', '.advertisement', '.ad', '.ads', '.cookie', '.popup', '.modal',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]'
  ];

  function parsePageContent(doc = document) {
    const clone = doc.cloneNode(true);
    EXCLUDE_SELECTORS.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    const content = [];
    const title = clone.querySelector('title')?.textContent?.trim();
    if (title) content.push(`# ${title}`);

    const metaDesc = clone.querySelector('meta[name="description"]')?.getAttribute('content');
    if (metaDesc) content.push(metaDesc.trim());

    const main = clone.querySelector('main, [role="main"], article, .content, #content') || clone.body;
    if (main) {
      main.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
        const level = parseInt(heading.tagName.charAt(1));
        const text = heading.textContent?.trim();
        if (text && text.length > 2) content.push(`\n${'#'.repeat(level)} ${text}`);
      });

      main.querySelectorAll('p').forEach(p => {
        const text = p.textContent?.trim();
        if (text && text.length > 20) content.push(text);
      });

      main.querySelectorAll('ul, ol').forEach(list => {
        list.querySelectorAll('li').forEach(item => {
          const text = item.textContent?.trim();
          if (text && text.length > 10) content.push(`• ${text}`);
        });
      });

      main.querySelectorAll('table').forEach(table => {
        table.querySelectorAll('tr').forEach(row => {
          const rowText = Array.from(row.querySelectorAll('td, th'))
            .map(cell => cell.textContent?.trim())
            .filter(Boolean)
            .join(' | ');
          if (rowText.length > 10) content.push(rowText);
        });
      });
    }

    return [...new Set(content)].join('\n\n');
  }

  function getInternalLinks(doc = document) {
    const currentHost = window.location.hostname;
    const currentPath = window.location.pathname;
    const links = new Set();

    doc.querySelectorAll('a[href]').forEach(link => {
      try {
        const url = new URL(link.href, window.location.origin);
        if (url.hostname !== currentHost) return;
        if (url.pathname === currentPath) return;
        const ext = url.pathname.split('.').pop().toLowerCase();
        if (['pdf', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'zip', 'doc', 'docx'].includes(ext)) return;
        if (['/wp-admin', '/admin', '/login', '/cart', '/checkout'].some(p => url.pathname.includes(p))) return;
        links.add(`${url.origin}${url.pathname}`);
      } catch (e) {}
    });

    const navLinks = [];
    doc.querySelectorAll('nav a[href], [role="navigation"] a[href], .nav a[href], .menu a[href]').forEach(link => {
      try {
        const url = new URL(link.href, window.location.origin);
        if (url.hostname === currentHost) navLinks.push(`${url.origin}${url.pathname}`);
      } catch (e) {}
    });

    const otherLinks = [];
    links.forEach(link => { if (!navLinks.includes(link)) otherLinks.push(link); });
    return [...new Set(navLinks), ...otherLinks];
  }

  async function fetchPage(url) {
    try {
      const response = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (error) {
      return null;
    }
  }

  async function parseSite(maxPages = 5, onProgress = null) {
    const results = { title: document.title, pages: [], content: '', pagesCount: 0 };
    const visited = new Set();
    const toVisit = [window.location.href];

    const currentContent = parsePageContent(document);
    results.pages.push({ url: window.location.href, content: currentContent });
    visited.add(window.location.href);
    if (onProgress) onProgress(1, maxPages);

    const links = getInternalLinks(document);
    toVisit.push(...links);

    while (toVisit.length > 0 && results.pages.length < maxPages) {
      const url = toVisit.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      const doc = await fetchPage(url);
      if (!doc) continue;

      const pageContent = parsePageContent(doc);
      if (pageContent.length > 100) {
        results.pages.push({ url, content: pageContent });
        if (onProgress) onProgress(results.pages.length, maxPages);

        getInternalLinks(doc).forEach(link => {
          if (!visited.has(link) && !toVisit.includes(link)) toVisit.push(link);
        });
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    results.content = results.pages.map(p => `--- ${p.url} ---\n${p.content}`).join('\n\n');
    const MAX_CONTENT_LENGTH = 50000;
    if (results.content.length > MAX_CONTENT_LENGTH) {
      results.content = results.content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[Контент обрезан]';
    }
    results.pagesCount = results.pages.length;
    return results;
  }

  // ==================== ВИДЖЕТ ====================

  let state = {
    isOpen: false,
    messages: [],
    siteData: null,
    settings: null,
    widget: null,
    usage: null,
    isLoading: false
  };

  const MIN_MESSAGE_INTERVAL = 1000;
  let lastMessageTime = 0;

  const FREE_MESSAGE_LIMIT = 50;
  const MAX_HISTORY_LENGTH = 100;
  const ERROR_DISPLAY_TIME = 5000;
  const MAX_RECENT_MESSAGES = 10;

  let elements = {
    container: null,
    button: null,
    window: null,
    messages: null,
    input: null,
    sendBtn: null
  };

  async function init() {
    await loadData();
    if (!state.settings?.apiKey) return;
    createWidget();
    setupEventListeners();
    loadChatHistory();
  }

  async function loadData() {
    try {
      const domain = window.location.hostname;
      const data = await chrome.storage.local.get(['settings', 'usage', 'widget', `site:${domain}`, `history:${domain}`]);
      state.settings = data.settings || {};
      state.usage = data.usage || { messagesThisMonth: 0, monthStart: '' };
      state.widget = data.widget || { color: '#4F46E5', position: 'top-right', botName: 'Помощник', avatar: null, greeting: 'Привет! Чем могу помочь?' };
      state.siteData = data[`site:${domain}`] || null;
      state.messages = data[`history:${domain}`] || [];
    } catch (e) {
      console.error('[AI Chatbot] Ошибка загрузки данных:', e);
    }
  }

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
          <div class="chat-avatar">${getSafeAvatarHtml(state.widget.avatar)}</div>
          <div class="chat-header-info">
            <div class="chat-header-name">${escapeHtml(state.widget.botName || 'Помощник')}</div>
            <div class="chat-header-status">Онлайн</div>
          </div>
          <button class="chat-close" aria-label="Закрыть">✕</button>
        </div>
        <div class="chat-messages"></div>
        <div class="chat-input-container">
          <textarea class="chat-input" placeholder="Напишите сообщение..." rows="1"></textarea>
          <button class="chat-send" aria-label="Отправить">
            <span class="chat-send-icon">➤</span>
          </button>
        </div>
        <div class="chat-footer">Powered by AI Chatbot</div>
      </div>
    `;

    document.body.appendChild(container);
    elements.container = container;
    elements.button = container.querySelector('.chat-button');
    elements.window = container.querySelector('.chat-window');
    elements.messages = container.querySelector('.chat-messages');
    elements.input = container.querySelector('.chat-input');
    elements.sendBtn = container.querySelector('.chat-send');
  }

  function setupEventListeners() {
    elements.button.addEventListener('click', toggleChat);
    elements.container.querySelector('.chat-close').addEventListener('click', toggleChat);
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    elements.input.addEventListener('input', () => {
      elements.input.style.height = 'auto';
      elements.input.style.height = Math.min(elements.input.scrollHeight, 100) + 'px';
    });
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  function toggleChat() {
    state.isOpen = !state.isOpen;
    elements.button.classList.toggle('open', state.isOpen);
    elements.window.classList.toggle('open', state.isOpen);
    if (state.isOpen) {
      elements.input.focus();
      if (state.messages.length === 0 && state.siteData) showGreeting();
      else if (!state.siteData) showNotTrained();
    }
  }

  function showGreeting() {
    addMessage('assistant', state.widget.greeting || 'Привет! Чем могу помочь?');
  }

  function showNotTrained() {
    elements.messages.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">📚</div>
        <div class="chat-welcome-text">Этот сайт ещё не обучен.<br>Откройте расширение и нажмите<br>"Обучить на этом сайте"</div>
      </div>
    `;
    elements.input.disabled = true;
    elements.sendBtn.disabled = true;
  }

  function loadChatHistory() {
    if (state.messages.length > 0) {
      state.messages.forEach(msg => renderMessage(msg.role, msg.text, msg.time, false));
      scrollToBottom();
    }
  }

  function addMessage(role, text) {
    const message = { role, text, time: new Date().toISOString() };
    state.messages.push(message);
    renderMessage(role, text, message.time);
    saveMessageToHistory(message);
    scrollToBottom();
  }

  function renderMessage(role, text, time, animate = true) {
    const timeStr = new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const avatar = role === 'assistant' ? getSafeAvatarHtml(state.widget.avatar) : '👤';
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
    const typing = elements.messages.querySelector('.message.typing');
    if (typing) typing.remove();
    elements.messages.appendChild(messageEl);
  }

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

  function scrollToBottom() {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  async function sendMessage() {
    const text = elements.input.value.trim();
    if (!text || state.isLoading) return;

    const now = Date.now();
    if (now - lastMessageTime < MIN_MESSAGE_INTERVAL) {
      showError('Подождите немного перед следующим сообщением');
      return;
    }
    lastMessageTime = now;

    if (!state.siteData) { showNotTrained(); return; }

    const isPro = state.settings.plan === 'pro';
    const messageLimit = isPro ? Infinity : FREE_MESSAGE_LIMIT;
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (state.usage.monthStart !== currentMonth) {
      state.usage.messagesThisMonth = 0;
      state.usage.monthStart = currentMonth;
    }

    if (state.usage.messagesThisMonth >= messageLimit) {
      showError(`Достигнут лимит сообщений (${messageLimit}/месяц). Перейдите на Pro.`);
      return;
    }

    addMessage('user', text);
    elements.input.value = '';
    elements.input.style.height = 'auto';
    state.isLoading = true;
    elements.sendBtn.disabled = true;
    showTyping();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'sendChatMessage',
        message: text,
        siteName: state.siteData.title || window.location.hostname,
        siteId: `site:${window.location.hostname}`,
        history: state.messages.slice(-MAX_RECENT_MESSAGES)
      });

      if (response.success) {
        addMessage('assistant', response.message);
        state.usage.messagesThisMonth++;
        await chrome.storage.local.set({ usage: state.usage });
      } else {
        throw new Error(response.error || 'Ошибка получения ответа');
      }
    } catch (error) {
      console.error('[AI Chatbot] Ошибка:', error);
      showError(error.message || 'Произошла ошибка. Попробуйте позже.');
      const typing = elements.messages.querySelector('.message.typing');
      if (typing) typing.remove();
    } finally {
      state.isLoading = false;
      elements.sendBtn.disabled = false;
    }
  }

  function showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'chat-error';
    errorEl.textContent = message;
    elements.messages.appendChild(errorEl);
    scrollToBottom();
    setTimeout(() => errorEl.remove(), ERROR_DISPLAY_TIME);
  }

  async function saveMessageToHistory(message) {
    if (state.settings.plan !== 'pro') return;
    try {
      const domain = window.location.hostname;
      await chrome.storage.local.set({ [`history:${domain}`]: state.messages.slice(-MAX_HISTORY_LENGTH) });
    } catch (e) {
      console.error('[AI Chatbot] Ошибка сохранения истории:', e);
    }
  }

  function handleMessage(message, sender, sendResponse) {
    switch (message.action) {
      case 'startParsing':
        handleParsing(message.maxPages).then(sendResponse);
        return true;
      case 'updateWidgetSettings':
        updateWidgetSettings(message.settings);
        sendResponse({ success: true });
        break;
      case 'ping':
        sendResponse({ success: true });
        break;
    }
  }

  async function handleParsing(maxPages) {
    try {
      const result = await parseSite(maxPages, (current, total) => {
        chrome.runtime.sendMessage({ action: 'parsingProgress', current, total });
      });
      return { success: true, title: result.title, content: result.content, pagesCount: result.pagesCount };
    } catch (error) {
      console.error('[AI Chatbot] Ошибка парсинга:', error);
      return { success: false, error: error.message };
    }
  }

  function updateWidgetSettings(settings) {
    state.widget = { ...state.widget, ...settings };
    if (elements.container) {
      elements.container.style.setProperty('--widget-color', settings.color);
      elements.container.style.setProperty('--widget-color-hover', adjustColor(settings.color, -20));
      elements.container.className = `position-${settings.position}`;
      const nameEl = elements.container.querySelector('.chat-header-name');
      if (nameEl) nameEl.textContent = settings.botName;
      const avatarEl = elements.container.querySelector('.chat-avatar');
      if (avatarEl) avatarEl.innerHTML = getSafeAvatarHtml(settings.avatar);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return ['http:', 'https:', 'data:'].includes(parsed.protocol);
    } catch { return false; }
  }

  function getSafeAvatarHtml(avatarUrl, fallbackEmoji = '🤖') {
    if (isValidImageUrl(avatarUrl)) return `<img src="${escapeHtml(avatarUrl)}" alt="Avatar">`;
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
