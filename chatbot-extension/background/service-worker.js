// service-worker.js — Фоновый скрипт расширения

// OpenAI API настройки
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const MAX_CONTEXT_LENGTH = 30000;
// API настройки
const API_TIMEOUT = 30000; // 30 секунд таймаут для API запросов
const MAX_TOKENS = 500;
const TEMPERATURE = 0.7;
const MAX_CACHE_SIZE = 5; // Максимум сайтов в кэше


// Кэш контента сайтов (для оптимизации - не передаём 50KB с каждым сообщением)
const siteContentCache = new Map();

/**
 * Получает контент сайта из кэша или storage
 * @param {string} siteId - ID сайта (формат: "site:domain.com")
 * @returns {Promise<Object|null>} Данные сайта или null
 */
async function getSiteContent(siteId) {
  // Проверяем кэш
  if (siteContentCache.has(siteId)) {
    return siteContentCache.get(siteId);
  }

  // Загружаем из storage
  const data = await chrome.storage.local.get(siteId);
  const siteData = data[siteId];

  if (siteData) {
    // Кэшируем (храним максимум 5 сайтов в памяти)
    if (siteContentCache.size >= MAX_CACHE_SIZE) {
      const firstKey = siteContentCache.keys().next().value;
      siteContentCache.delete(firstKey);
    }
    siteContentCache.set(siteId, siteData);
    return siteData;
  }

  return null;
}



// Слушаем сообщения от popup и content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'sendChatMessage':
      handleChatMessage(message).then(sendResponse);
      return true; // Асинхронный ответ

    case 'validateApiKey':
      validateApiKey(message.apiKey).then(sendResponse);
      return true;

    case 'parsingProgress':
      // Пересылаем в popup
      forwardToPopup(message);
      break;
  }
});

/**
 * Обрабатывает сообщение чата и отправляет запрос к OpenAI
 * @param {Object} params - Параметры сообщения
 * @param {string} params.message - Текст сообщения пользователя
 * @param {string} params.siteName - Название сайта
 * @param {string} [params.siteContent] - Контент сайта (опционально)
 * @param {string} [params.siteId] - ID сайта для получения контента из кэша
 * @param {Array} params.history - История сообщений
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function handleChatMessage({ message, siteName, siteContent, siteId, history }) {
  // Если передан siteId вместо контента - получаем из кэша/storage
  let actualContent = siteContent;
  if (siteId && !siteContent) {
    const siteData = await getSiteContent(siteId);
    if (siteData) {
      actualContent = siteData.content;
      if (!siteName) siteName = siteData.title;
    }
  }

  if (!actualContent) {
    return { success: false, error: 'Контент сайта не найден' };
  }

  try {
    // Получаем API ключ
    const data = await chrome.storage.local.get('settings');
    const apiKey = data.settings?.apiKey;

    if (!apiKey) {
      return { success: false, error: 'API ключ не настроен' };
    }

    // Формируем системный промпт
    const systemPrompt = getSystemPrompt(siteName, actualContent);

    // Формируем историю сообщений
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(msg => ({
        role: msg.role,
        content: msg.text || msg.content
      })),
      { role: 'user', content: message }
    ];

    // Отправляем запрос к OpenAI с таймаутом
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

    const response = await fetch(OPENAI_API_URL, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE
      })
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json();
      if (response.status === 401) {
        return { success: false, error: 'Неверный API ключ' };
      }
      if (response.status === 429) {
        return { success: false, error: 'Превышен лимит запросов OpenAI. Подождите немного.' };
      }
      if (response.status === 402) {
        return { success: false, error: 'Недостаточно средств на аккаунте OpenAI' };
      }
      return { success: false, error: error.error?.message || 'Ошибка API' };
    }

    const result = await response.json();
    const assistantMessage = result.choices[0]?.message?.content;

    if (!assistantMessage) {
      return { success: false, error: 'Пустой ответ от AI' };
    }

    return {
      success: true,
      message: assistantMessage.trim()
    };

  } catch (error) {
    console.error('[AI Chatbot] Ошибка:', error);

    if (error.name === 'AbortError') {
      return { success: false, error: 'Превышено время ожидания ответа. Попробуйте позже.' };
    }

    if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
      return { success: false, error: 'Нет подключения к интернету' };
    }

    return { success: false, error: error.message || 'Произошла ошибка' };
  }
}

/**
 * Генерирует системный промпт для AI
 * @param {string} siteName - Название сайта
 * @param {string} siteContent - Контент сайта
 * @returns {string} Системный промпт
 */
function getSystemPrompt(siteName, siteContent) {
  // Обрезаем контент если слишком длинный
  const truncatedContent = siteContent.length > MAX_CONTEXT_LENGTH
    ? siteContent.slice(0, MAX_CONTEXT_LENGTH) + '\n\n[Контент обрезан...]'
    : siteContent;

  return `Ты — дружелюбный помощник сайта "${siteName}".

СТИЛЬ ОТВЕТОВ:
- Отвечай КОРОТКО: 1-3 предложения максимум
- Пиши как человек в чате, не как робот
- Без списков и буллетов — просто текст
- Дай суть, не перечисляй всё подряд
- Будь тёплым и приветливым

ПРИМЕРЫ ХОРОШИХ ОТВЕТОВ:
❌ Плохо: "После прохождения курса вы сможете: - писать код - работать с функциями - понимать JavaScript..."
✅ Хорошо: "Научитесь писать веб-приложения на JavaScript с нуля — от основ до работы с DOM и формами 🚀"

❌ Плохо: "Стоимость курса составляет 3999 рублей. Также есть скидка..."
✅ Хорошо: "Курс стоит от 3 999 ₽, а ещё можно начать бесплатно!"

ПРАВИЛА:
- Используй ТОЛЬКО информацию с сайта ниже
- Нет информации? Скажи честно и предложи связаться с поддержкой
- Отвечай на языке вопроса

КОНТЕНТ САЙТА:
---
${truncatedContent}
---`;
}

/**
 * Проверяет валидность OpenAI API ключа
 * @param {string} apiKey - API ключ для проверки
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateApiKey(apiKey) {
  // Поддерживаем разные форматы ключей OpenAI: sk-..., sk-proj-...
  if (!apiKey || !apiKey.startsWith('sk-') || apiKey.length < 20) {
    return { valid: false, error: 'Неверный формат ключа' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401) {
      return { valid: false, error: 'Неверный API ключ' };
    }

    return { valid: false, error: 'Ошибка проверки ключа' };
  } catch (error) {
    return { valid: false, error: 'Ошибка сети' };
  }
}

// Пересылка сообщения в popup (используем chrome.runtime.sendMessage вместо deprecated getViews)
async function forwardToPopup(message) {
  try {
    // Отправляем сообщение через runtime API
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // Popup может быть закрыт — это нормально
  }
}

// Обработка установки расширения
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Инициализация дефолтных значений
    chrome.storage.local.set({
      settings: {
        apiKey: '',
        plan: 'free',
        stripeEmail: null,
        proActivatedAt: null
      },
      usage: {
        messagesThisMonth: 0,
        monthStart: new Date().toISOString().slice(0, 7),
        sitesCount: 0
      },
      widget: {
        color: '#4F46E5',
        position: 'top-right',
        botName: 'Помощник',
        avatar: null,
        greeting: 'Привет! Чем могу помочь?'
      }
    });

    // Установка завершена
  }
});

// Очистка старых данных при запуске
chrome.runtime.onStartup.addListener(async () => {
  // Проверяем и сбрасываем счётчик если новый месяц
  const data = await chrome.storage.local.get('usage');
  const usage = data.usage || {};
  const currentMonth = new Date().toISOString().slice(0, 7);

  if (usage.monthStart !== currentMonth) {
    usage.messagesThisMonth = 0;
    usage.monthStart = currentMonth;
    await chrome.storage.local.set({ usage });
    // Счётчик сброшен
  }
});
