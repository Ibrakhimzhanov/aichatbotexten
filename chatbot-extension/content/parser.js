// parser.js — Парсинг контента страниц

// Селекторы для исключения
const EXCLUDE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'video',
  'audio',
  'nav',
  'footer',
  'header',
  '.nav',
  '.navigation',
  '.menu',
  '.footer',
  '.header',
  '.sidebar',
  '.advertisement',
  '.ad',
  '.ads',
  '.cookie',
  '.popup',
  '.modal',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]'
];

// Парсинг текста страницы
function parsePageContent(doc = document) {
  // Клонируем документ чтобы не изменять оригинал
  const clone = doc.cloneNode(true);

  // Удаляем ненужные элементы
  EXCLUDE_SELECTORS.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });

  // Собираем структурированный контент
  const content = [];

  // Title
  const title = clone.querySelector('title')?.textContent?.trim();
  if (title) {
    content.push(`# ${title}`);
  }

  // Meta description
  const metaDesc = clone.querySelector('meta[name="description"]')?.getAttribute('content');
  if (metaDesc) {
    content.push(metaDesc.trim());
  }

  // Заголовки и текст
  const main = clone.querySelector('main, [role="main"], article, .content, #content') || clone.body;

  if (main) {
    // H1-H6 заголовки с текстом после них
    const headings = main.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach(heading => {
      const level = parseInt(heading.tagName.charAt(1));
      const prefix = '#'.repeat(level);
      const text = heading.textContent?.trim();
      if (text && text.length > 2) {
        content.push(`\n${prefix} ${text}`);
      }
    });

    // Параграфы
    const paragraphs = main.querySelectorAll('p');
    paragraphs.forEach(p => {
      const text = p.textContent?.trim();
      if (text && text.length > 20) {
        content.push(text);
      }
    });

    // Списки
    const lists = main.querySelectorAll('ul, ol');
    lists.forEach(list => {
      const items = list.querySelectorAll('li');
      items.forEach(item => {
        const text = item.textContent?.trim();
        if (text && text.length > 10) {
          content.push(`• ${text}`);
        }
      });
    });

    // Таблицы (упрощённо)
    const tables = main.querySelectorAll('table');
    tables.forEach(table => {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        const rowText = Array.from(cells)
          .map(cell => cell.textContent?.trim())
          .filter(Boolean)
          .join(' | ');
        if (rowText.length > 10) {
          content.push(rowText);
        }
      });
    });
  }

  // Собираем всё вместе и убираем дубликаты
  const uniqueContent = [...new Set(content)];
  return uniqueContent.join('\n\n');
}

// Получение внутренних ссылок
function getInternalLinks(doc = document) {
  const currentHost = window.location.hostname;
  const currentPath = window.location.pathname;
  const links = new Set();

  doc.querySelectorAll('a[href]').forEach(link => {
    try {
      const url = new URL(link.href, window.location.origin);

      // Только тот же домен
      if (url.hostname !== currentHost) return;

      // Игнорируем якоря и параметры на той же странице
      if (url.pathname === currentPath) return;

      // Игнорируем файлы
      const ext = url.pathname.split('.').pop().toLowerCase();
      if (['pdf', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'zip', 'doc', 'docx'].includes(ext)) return;

      // Игнорируем служебные ссылки
      if (url.pathname.includes('/wp-admin') ||
          url.pathname.includes('/admin') ||
          url.pathname.includes('/login') ||
          url.pathname.includes('/cart') ||
          url.pathname.includes('/checkout')) return;

      // Добавляем чистый URL без параметров и якорей
      const cleanUrl = `${url.origin}${url.pathname}`;
      links.add(cleanUrl);
    } catch (e) {
      // Игнорируем невалидные URL
    }
  });

  // Приоритет ссылкам из навигации
  const navLinks = [];
  const otherLinks = [];

  doc.querySelectorAll('nav a[href], [role="navigation"] a[href], .nav a[href], .menu a[href]').forEach(link => {
    try {
      const url = new URL(link.href, window.location.origin);
      if (url.hostname === currentHost) {
        navLinks.push(`${url.origin}${url.pathname}`);
      }
    } catch (e) {}
  });

  links.forEach(link => {
    if (!navLinks.includes(link)) {
      otherLinks.push(link);
    }
  });

  return [...new Set(navLinks), ...otherLinks];
}

// Загрузка страницы
async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'Accept': 'text/html'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  } catch (error) {
    console.warn(`[AI Chatbot] Не удалось загрузить ${url}:`, error.message);
    return null;
  }
}

// Основная функция парсинга сайта
async function parseSite(maxPages = 5, onProgress = null) {
  const results = {
    title: document.title,
    pages: [],
    content: '',
    pagesCount: 0
  };

  const visited = new Set();
  const toVisit = [window.location.href];

  // Парсим текущую страницу
  const currentContent = parsePageContent(document);
  results.pages.push({
    url: window.location.href,
    content: currentContent
  });
  visited.add(window.location.href);

  if (onProgress) onProgress(1, maxPages);

  // Получаем ссылки с текущей страницы
  const links = getInternalLinks(document);
  toVisit.push(...links);

  // Парсим остальные страницы
  while (toVisit.length > 0 && results.pages.length < maxPages) {
    const url = toVisit.shift();

    if (visited.has(url)) continue;
    visited.add(url);

    const doc = await fetchPage(url);
    if (!doc) continue;

    const pageContent = parsePageContent(doc);
    if (pageContent.length > 100) {
      results.pages.push({
        url: url,
        content: pageContent
      });

      if (onProgress) onProgress(results.pages.length, maxPages);

      // Добавляем новые ссылки
      const newLinks = getInternalLinks(doc);
      newLinks.forEach(link => {
        if (!visited.has(link) && !toVisit.includes(link)) {
          toVisit.push(link);
        }
      });
    }

    // Небольшая задержка между запросами
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Объединяем контент
  results.content = results.pages
    .map(p => `--- ${p.url} ---\n${p.content}`)
    .join('\n\n');

  // Ограничиваем длину контента
  const MAX_CONTENT_LENGTH = 50000;
  if (results.content.length > MAX_CONTENT_LENGTH) {
    results.content = results.content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[Контент обрезан из-за ограничения размера]';
  }

  results.pagesCount = results.pages.length;

  return results;
}

// Экспортируем функции в глобальную область
window.AIChatbotParser = {
  parsePageContent,
  getInternalLinks,
  fetchPage,
  parseSite
};
