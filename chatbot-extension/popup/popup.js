// Popup.js — Логика popup окна расширения

// DOM элементы
const elements = {
  // API ключ
  apiKey: document.getElementById('apiKey'),
  toggleKey: document.getElementById('toggleKey'),
  saveKey: document.getElementById('saveKey'),
  keyStatus: document.getElementById('keyStatus'),

  // Статус
  planStatus: document.getElementById('planStatus'),
  messagesCount: document.getElementById('messagesCount'),
  sitesCount: document.getElementById('sitesCount'),
  upgradePro: document.getElementById('upgradePro'),

  // Pro активация
  proActivation: document.getElementById('proActivation'),
  proEmail: document.getElementById('proEmail'),
  activatePro: document.getElementById('activatePro'),
  proStatus: document.getElementById('proStatus'),

  // Текущий сайт
  currentSite: document.getElementById('currentSite'),
  trainSite: document.getElementById('trainSite'),
  trainStatus: document.getElementById('trainStatus'),
  trainProgress: document.getElementById('trainProgress'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),

  // Список сайтов
  sitesList: document.getElementById('sitesList'),

  // Настройки виджета
  widgetSettings: document.getElementById('widgetSettings'),
  widgetSettingsContent: document.getElementById('widgetSettingsContent'),
  proOnlyBadge: document.getElementById('proOnlyBadge'),
  widgetColor: document.getElementById('widgetColor'),
  widgetPosition: document.getElementById('widgetPosition'),
  botName: document.getElementById('botName'),
  greeting: document.getElementById('greeting'),
  saveWidget: document.getElementById('saveWidget'),
  widgetStatus: document.getElementById('widgetStatus')
};

// Лимиты
const LIMITS = {
  free: { messages: 50, sites: 1, pages: 5 },
  pro: { messages: Infinity, sites: 10, pages: 20 }
};

// UI настройки
const STATUS_DISPLAY_TIME = 3000; // 3 секунды для показа статуса
const PROGRESS_HIDE_DELAY = 2000; // 2 секунды перед скрытием прогресса

// ВАЖНО: Замените на свою ссылку Stripe Payment Link перед публикацией!
// Создайте ссылку в Stripe Dashboard: https://dashboard.stripe.com/payment-links
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/YOUR_PAYMENT_LINK';

// Состояние

/**
 * Экранирует HTML символы для предотвращения XSS
 * @param {string} text - Текст для экранирования
 * @returns {string} Экранированный текст
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let state = {
  settings: { apiKey: '', plan: 'free', stripeEmail: null, proActivatedAt: null },
  usage: { messagesThisMonth: 0, monthStart: '', sitesCount: 0 },
  widget: { color: '#4F46E5', position: 'bottom-right', botName: 'Помощник', avatar: null, greeting: 'Привет! Чем могу помочь?' },
  sites: [],
  currentTabUrl: ''
};

// Инициализация
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadState();
  await getCurrentTab();
  updateUI();
  setupEventListeners();
}

// Загрузка состояния из storage
async function loadState() {
  const data = await chrome.storage.local.get(['settings', 'usage', 'widget']);

  if (data.settings) state.settings = { ...state.settings, ...data.settings };
  if (data.usage) state.usage = { ...state.usage, ...data.usage };
  if (data.widget) state.widget = { ...state.widget, ...data.widget };

  // Проверяем и сбрасываем счётчик сообщений если новый месяц
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (state.usage.monthStart !== currentMonth) {
    state.usage.messagesThisMonth = 0;
    state.usage.monthStart = currentMonth;
    await chrome.storage.local.set({ usage: state.usage });
  }

  // Загружаем список сайтов
  const allData = await chrome.storage.local.get(null);
  state.sites = Object.keys(allData)
    .filter(key => key.startsWith('site:'))
    .map(key => ({ id: key, ...allData[key] }));

  state.usage.sitesCount = state.sites.length;
}

// Получение текущей вкладки
async function getCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      state.currentTabUrl = url.hostname;
    }
  } catch (e) {
    state.currentTabUrl = '';
  }
}

// Обновление UI
function updateUI() {
  // API ключ
  elements.apiKey.value = state.settings.apiKey || '';

  // План
  const isPro = state.settings.plan === 'pro';
  const limits = isPro ? LIMITS.pro : LIMITS.free;

  elements.planStatus.textContent = isPro ? 'Pro' : 'Free';
  elements.planStatus.className = `stat-value badge ${isPro ? 'badge-pro' : 'badge-free'}`;

  // Статистика
  const messagesLimit = limits.messages === Infinity ? '∞' : limits.messages;
  elements.messagesCount.textContent = `${state.usage.messagesThisMonth}/${messagesLimit} в этом месяце`;
  elements.sitesCount.textContent = `${state.usage.sitesCount}/${limits.sites}`;

  // Кнопка Pro
  if (isPro) {
    elements.upgradePro.textContent = '✓ Pro активирован';
    elements.upgradePro.disabled = true;
    elements.upgradePro.classList.remove('btn-upgrade');
    elements.upgradePro.classList.add('btn-secondary');
    elements.proActivation.classList.add('hidden');
  }

  // Текущий сайт
  elements.currentSite.textContent = state.currentTabUrl || '—';

  // Проверяем обучен ли текущий сайт
  const currentSiteData = state.sites.find(s => s.id === `site:${state.currentTabUrl}`);
  if (currentSiteData) {
    elements.trainSite.textContent = '🔄 Переобучить сайт';
    showStatus(elements.trainStatus, `✅ Обучено (${currentSiteData.pagesCount} страниц)`, 'success');
  } else {
    elements.trainSite.textContent = '📚 Обучить на этом сайте';
  }

  // Проверяем лимит сайтов
  if (!currentSiteData && state.usage.sitesCount >= limits.sites) {
    elements.trainSite.disabled = true;
    showStatus(elements.trainStatus, `Достигнут лимит сайтов (${limits.sites})`, 'error');
  }

  // Список обученных сайтов
  renderSitesList();

  // Настройки виджета
  if (isPro) {
    elements.widgetSettingsContent.classList.remove('disabled');
    elements.proOnlyBadge.classList.add('hidden');
  } else {
    elements.widgetSettingsContent.classList.add('disabled');
    elements.proOnlyBadge.classList.remove('hidden');
  }

  elements.widgetColor.value = state.widget.color;
  elements.widgetPosition.value = state.widget.position;
  elements.botName.value = state.widget.botName;
  elements.greeting.value = state.widget.greeting;
}

// Рендер списка сайтов
function renderSitesList() {
  if (state.sites.length === 0) {
    elements.sitesList.innerHTML = '<li class="empty-state">Нет обученных сайтов</li>';
    return;
  }

  elements.sitesList.innerHTML = state.sites.map(site => {
    const domain = escapeHtml(site.id.replace('site:', ''));
    const date = escapeHtml(new Date(site.parsedAt).toLocaleDateString('ru-RU'));
    const siteIdEscaped = escapeHtml(site.id);
    return `
      <li>
        <div class="site-info">
          <span class="site-name">${domain}</span>
          <span class="site-meta">${site.pagesCount} стр. • ${date}</span>
        </div>
        <button class="btn btn-danger" data-site="${siteIdEscaped}">✕</button>
      </li>
    `;
  }).join('');

  // Обработчики удаления
  elements.sitesList.querySelectorAll('.btn-danger').forEach(btn => {
    btn.addEventListener('click', () => deleteSite(btn.dataset.site));
  });
}

// Удаление сайта
async function deleteSite(siteId) {
  await chrome.storage.local.remove([siteId, `history:${siteId.replace('site:', '')}`]);
  state.sites = state.sites.filter(s => s.id !== siteId);
  state.usage.sitesCount = state.sites.length;
  await chrome.storage.local.set({ usage: state.usage });
  updateUI();
}

/**
 * Показывает статусное сообщение
 * @param {HTMLElement} element - Элемент для отображения статуса
 * @param {string} message - Текст сообщения
 * @param {'success'|'error'|'info'} type - Тип сообщения
 */
function showStatus(element, message, type) {
  element.textContent = message;
  element.className = `status show ${type}`;

  if (type !== 'error') {
    setTimeout(() => {
      element.classList.remove('show');
    }, STATUS_DISPLAY_TIME);
  }
}

// Настройка обработчиков событий
function setupEventListeners() {
  // Показать/скрыть API ключ
  elements.toggleKey.addEventListener('click', () => {
    const type = elements.apiKey.type === 'password' ? 'text' : 'password';
    elements.apiKey.type = type;
    elements.toggleKey.textContent = type === 'password' ? '👁️' : '🙈';
  });

  // Сохранить API ключ
  elements.saveKey.addEventListener('click', saveApiKey);

  // Перейти на Pro (тестовый режим - без Stripe)
  elements.upgradePro.addEventListener('click', () => {
    // TODO: Раскомментировать для продакшена с реальным Stripe
    // window.open(STRIPE_PAYMENT_LINK, '_blank');
    elements.proActivation.classList.remove('hidden');
  });

  // Активировать Pro
  elements.activatePro.addEventListener('click', activatePro);

  // Обучить сайт
  elements.trainSite.addEventListener('click', trainSite);

  // Сохранить настройки виджета
  elements.saveWidget.addEventListener('click', saveWidgetSettings);
}

// Сохранение API ключа
async function saveApiKey() {
  const key = elements.apiKey.value.trim();

  if (!key) {
    showStatus(elements.keyStatus, 'Введите API ключ', 'error');
    return;
  }

  // Поддерживаем разные форматы ключей OpenAI: sk-..., sk-proj-...
  if (!key.startsWith('sk-')) {
    showStatus(elements.keyStatus, 'Неверный формат ключа (должен начинаться с sk-)', 'error');
    return;
  }

  // Минимальная длина ключа
  if (key.length < 20) {
    showStatus(elements.keyStatus, 'Ключ слишком короткий', 'error');
    return;
  }

  state.settings.apiKey = key;
  await chrome.storage.local.set({ settings: state.settings });

  showStatus(elements.keyStatus, '✓ Ключ сохранён', 'success');
}

// Активация Pro
// ВНИМАНИЕ: Это упрощённая активация без верификации оплаты!
// Для продакшена необходимо реализовать backend с проверкой через Stripe API.
// Текущая реализация позволяет активировать Pro без реальной оплаты.
async function activatePro() {
  const email = elements.proEmail.value.trim();

  if (!email || !email.includes('@')) {
    showStatus(elements.proStatus, 'Введите корректный email', 'error');
    return;
  }

  // TODO: Добавить верификацию оплаты через backend/Stripe API
  // Пример: const verified = await verifyStripePayment(email);
  // if (!verified) { showStatus(...); return; }

  state.settings.plan = 'pro';
  state.settings.stripeEmail = email;
  state.settings.proActivatedAt = new Date().toISOString();

  await chrome.storage.local.set({ settings: state.settings });

  showStatus(elements.proStatus, '✓ Pro активирован!', 'success');
  updateUI();
}

/**
 * Запускает обучение AI на текущем сайте
 * Парсит страницы и сохраняет контент в storage
 */
async function trainSite() {
  if (!state.settings.apiKey) {
    showStatus(elements.trainStatus, 'Сначала сохраните API ключ', 'error');
    return;
  }

  if (!state.currentTabUrl) {
    showStatus(elements.trainStatus, 'Не удалось определить сайт', 'error');
    return;
  }

  const isPro = state.settings.plan === 'pro';
  const maxPages = isPro ? LIMITS.pro.pages : LIMITS.free.pages;

  elements.trainSite.disabled = true;
  elements.trainSite.textContent = '⏳ Обучение...';
  elements.trainProgress.classList.remove('hidden');
  elements.progressFill.style.width = '0%';
  elements.progressText.textContent = `0/${maxPages} страниц`;

  try {
    // Отправляем сообщение в content script для начала парсинга
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Сначала инжектим content script если его нет
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });
      // Даём время на инициализацию
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      console.log('Content script injection:', e.message);
    }

    // Отправляем команду на парсинг
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        action: 'startParsing',
        maxPages: maxPages
      });
    } catch (e) {
      // Если не удалось связаться - просим перезагрузить страницу
      throw new Error('Перезагрузите страницу (F5) и попробуйте снова');
    }

    if (response && response.success) {
      // Сохраняем результат
      const siteId = `site:${state.currentTabUrl}`;
      const siteData = {
        url: tab.url,
        title: response.title || state.currentTabUrl,
        parsedAt: new Date().toISOString(),
        pagesCount: response.pagesCount,
        content: response.content,
        contentLength: response.content.length
      };

      await chrome.storage.local.set({ [siteId]: siteData });

      // Обновляем счётчик сайтов если это новый сайт
      if (!state.sites.find(s => s.id === siteId)) {
        state.usage.sitesCount++;
        await chrome.storage.local.set({ usage: state.usage });
      }

      state.sites = state.sites.filter(s => s.id !== siteId);
      state.sites.push({ id: siteId, ...siteData });

      elements.progressFill.style.width = '100%';
      elements.progressText.textContent = `${response.pagesCount}/${maxPages} страниц`;

      showStatus(elements.trainStatus, `✅ Обучено! (${response.pagesCount} страниц, ${Math.round(response.content.length / 1000)}K символов)`, 'success');
    } else {
      throw new Error(response?.error || 'Ошибка парсинга');
    }
  } catch (error) {
    console.error('Training error:', error);
    showStatus(elements.trainStatus, `Ошибка: ${error.message}`, 'error');
  } finally {
    elements.trainSite.disabled = false;
    elements.trainSite.textContent = '📚 Обучить на этом сайте';
    setTimeout(() => {
      elements.trainProgress.classList.add('hidden');
    }, PROGRESS_HIDE_DELAY);
    updateUI();
  }
}

// Сохранение настроек виджета
async function saveWidgetSettings() {
  state.widget = {
    color: elements.widgetColor.value,
    position: elements.widgetPosition.value,
    botName: elements.botName.value.trim() || 'Помощник',
    avatar: state.widget.avatar,
    greeting: elements.greeting.value.trim() || 'Привет! Чем могу помочь?'
  };

  await chrome.storage.local.set({ widget: state.widget });

  // Отправляем обновление в content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, {
      action: 'updateWidgetSettings',
      settings: state.widget
    });
  } catch (e) {
    // Content script может быть не загружен
  }

  showStatus(elements.widgetStatus, '✓ Настройки сохранены', 'success');
}

// Слушаем сообщения о прогрессе парсинга
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'parsingProgress') {
    const isPro = state.settings.plan === 'pro';
    const maxPages = isPro ? LIMITS.pro.pages : LIMITS.free.pages;
    const progress = (message.current / maxPages) * 100;

    elements.progressFill.style.width = `${progress}%`;
    elements.progressText.textContent = `${message.current}/${maxPages} страниц`;
  }
});
