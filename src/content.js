(() => {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const ROOT_ID = 'kirilltube-root-v12';
  const STOP_WORDS = new Set('и в во на с со к ко по для от до из у о об про это как что где когда почему или но а не без при уже ещё ли мы вы он она они мой моя ваши наш обзор видео канал ролик youtube shorts the a an and or of to in on for with from is are how what why this that'.split(/\s+/));

  const state = {
    root: null,
    settings: null,
    context: null,
    tab: 'overview',
    searchCache: new Map(),
    channelCache: new Map(),
    currentVideo: null,
    dna: null,
    busy: false,
    lastUrl: location.href,
    resizeTimer: null
  };

  function sendMessage(message) {
    try {
      const result = ext.runtime.sendMessage(message);
      if (result && typeof result.then === 'function') return result;
      return new Promise((resolve, reject) => {
        ext.runtime.sendMessage(message, response => {
          const error = ext.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function formatNumber(value) {
    const number = Number(value || 0);
    return new Intl.NumberFormat('ru-RU', { notation: number >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
  }

  function ageLabel(dateValue) {
    const time = new Date(dateValue).getTime();
    if (!Number.isFinite(time)) return 'дата неизвестна';
    const days = Math.max(0, (Date.now() - time) / 86400000);
    if (days < 1) return `${Math.max(1, Math.round(days * 24))} ч назад`;
    if (days < 30) return `${Math.round(days)} дн. назад`;
    if (days < 365) return `${Math.round(days / 30)} мес. назад`;
    return `${(days / 365).toFixed(1)} г. назад`;
  }

  function parseDuration(value) {
    const match = String(value || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  function durationLabel(seconds) {
    seconds = Math.max(0, Number(seconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s-]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(value) {
    return normalizeText(value)
      .split(' ')
      .map(word => word.replace(/^-+|-+$/g, ''))
      .filter(word => word.length >= 3 && !STOP_WORDS.has(word));
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function keywordsFromTexts(texts, limit = 15) {
    const counts = new Map();
    for (const text of texts) {
      for (const word of words(text)) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));
  }

  function titleScore(title) {
    const text = String(title || '').trim();
    let score = 48;
    if (text.length >= 38 && text.length <= 68) score += 18;
    else if (text.length >= 28 && text.length <= 82) score += 10;
    else score -= 8;
    if (/\d/.test(text)) score += 7;
    if (/[?!—:]/.test(text)) score += 5;
    if (/как|почему|ошиб|тест|сравн|провер|секрет|правд|реальн|лучший|хуже|против/i.test(text)) score += 10;
    if (text === text.toUpperCase() && text.length > 12) score -= 12;
    if ((text.match(/[!?]/g) || []).length > 2) score -= 6;
    return clamp(score, 0, 100);
  }

  function similarity(query, item) {
    const queryWords = new Set(words(query));
    const titleWords = new Set(words(item.title));
    const descriptionWords = new Set(words(item.description));
    const tagWords = new Set((item.tags || []).flatMap(tag => words(tag)));
    if (!queryWords.size) return 0;
    let titleHits = 0;
    let descriptionHits = 0;
    let tagHits = 0;
    queryWords.forEach(word => {
      if (titleWords.has(word)) titleHits += 1;
      if (descriptionWords.has(word)) descriptionHits += 1;
      if (tagWords.has(word)) tagHits += 1;
    });
    const exact = normalizeText(item.title).includes(normalizeText(query)) ? 1 : 0;
    return clamp(Math.round((titleHits / queryWords.size) * 56 + (tagHits / queryWords.size) * 24 + (descriptionHits / queryWords.size) * 12 + exact * 8), 0, 100);
  }

  function viewsPerDay(item) {
    const days = Math.max(0.25, (Date.now() - new Date(item.publishedAt).getTime()) / 86400000);
    return Number(item.views || 0) / days;
  }

  function median(values) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function getPageContext() {
    const url = new URL(location.href);
    const videoId = url.searchParams.get('v') || (url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : '');
    const titleNode = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, #title h1');
    const ownerNode = document.querySelector('ytd-video-owner-renderer #channel-name a, #owner #channel-name a, ytd-channel-name a');
    const metaTitle = document.querySelector('meta[name="title"], meta[property="og:title"]')?.content;
    const metaDescription = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content;
    const metaKeywords = document.querySelector('meta[name="keywords"]')?.content || '';
    const channelId = document.querySelector('meta[itemprop="channelId"]')?.content || document.querySelector('link[itemprop="url"][href*="/channel/"]')?.href?.split('/channel/')[1]?.split(/[/?#]/)[0] || '';
    const title = (titleNode?.textContent || metaTitle || document.title.replace(/\s*-\s*YouTube\s*$/i, '')).trim();
    const channelName = (ownerNode?.textContent || '').trim();
    const channelUrl = ownerNode?.href || '';
    const suggestedQuery = unique(words(`${title} ${metaKeywords}`).slice(0, 6)).join(' ') || title;
    return {
      url: location.href,
      videoId,
      title,
      description: metaDescription || '',
      tags: metaKeywords.split(',').map(value => value.trim()).filter(Boolean),
      channelId,
      channelName,
      channelUrl,
      suggestedQuery
    };
  }

  function apiErrorText(error) {
    const reason = error?.reason || 'unknown';
    const message = error?.message || 'Неизвестная ошибка YouTube API';
    const labels = {
      missingApiKey: 'API-ключ не сохранён',
      keyInvalid: 'API-ключ недействителен',
      accessNotConfigured: 'YouTube Data API v3 не включён в Google Cloud',
      quotaExceeded: 'Дневная квота YouTube API закончилась',
      dailyLimitExceeded: 'Дневной лимит YouTube API закончился',
      rateLimitExceeded: 'Слишком много запросов подряд',
      forbidden: 'Запрос запрещён настройками ключа',
      ipRefererBlocked: 'Ограничения API-ключа блокируют запрос расширения'
    };
    return `${labels[reason] || message}${labels[reason] && message !== labels[reason] ? `: ${message}` : ''}`;
  }

  async function api(resource, params) {
    const response = await sendMessage({ type: 'api:request', resource, params });
    if (!response?.ok) {
      const error = new Error(response?.error?.message || 'Ошибка YouTube API');
      Object.assign(error, response?.error || {});
      throw error;
    }
    return response.data || {};
  }

  async function loadSettings() {
    const response = await sendMessage({ type: 'settings:get' });
    state.settings = response?.settings || {
      youtubeApiKey: '', locale: 'ru', regionCode: 'RU', resultLimit: 24,
      textScale: 100, panelWidth: 580, panelHeight: 760, theme: 'dark'
    };
  }

  async function persistPanelSize() {
    if (!state.root || state.root.classList.contains('kt-fullscreen')) return;
    const rect = state.root.getBoundingClientRect();
    const values = {
      panelWidth: Math.round(rect.width),
      panelHeight: Math.round(rect.height)
    };
    state.settings = { ...state.settings, ...values };
    await sendMessage({ type: 'settings:set', values }).catch(() => {});
  }

  function createPanel() {
    if (document.getElementById(ROOT_ID)) return document.getElementById(ROOT_ID);
    const root = document.createElement('section');
    root.id = ROOT_ID;
    root.className = `kt-theme-${state.settings?.theme || 'dark'}`;
    root.style.width = `${clamp(state.settings?.panelWidth || 580, 430, Math.max(460, innerWidth - 24))}px`;
    root.style.height = `${clamp(state.settings?.panelHeight || 760, 520, Math.max(560, innerHeight - 24))}px`;
    root.style.setProperty('--kt-scale', String((state.settings?.textScale || 100) / 100));
    root.innerHTML = `
      <header class="kt-header">
        <div class="kt-brand"><span class="kt-logo">K▶</span><span><strong>KirillTube</strong><small>YouTube Content Intelligence</small></span></div>
        <div class="kt-window-actions">
          <button data-action="zoom-out" title="Уменьшить текст">−</button>
          <button data-action="zoom-in" title="Увеличить текст">+</button>
          <button data-action="fullscreen" title="На весь экран">⛶</button>
          <button data-action="refresh" title="Обновить данные">↻</button>
          <button data-action="close" title="Закрыть">×</button>
        </div>
      </header>
      <nav class="kt-tabs" aria-label="Разделы KirillTube">
        ${[
          ['overview','Обзор'],['twins','Видео-близнецы'],['channels','Похожие каналы'],['dna','ДНК'],
          ['gaps','Пробелы'],['ideas','Студия'],['trends','Тренды'],['saved','Сохранённое']
        ].map(([id,label]) => `<button data-tab="${id}">${label}</button>`).join('')}
      </nav>
      <main class="kt-main"></main>
      <footer class="kt-footer"><span class="kt-api-state"><i></i> Проверяю API…</span><button data-action="settings">Настройки</button></footer>
      <div class="kt-resize-hint" title="Потяните для изменения размера"></div>
    `;
    document.documentElement.appendChild(root);
    state.root = root;

    root.addEventListener('click', handlePanelClick);
    root.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target?.matches('[data-search-input]')) runCurrentSearch();
    });
    root.addEventListener('pointerup', () => {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(persistPanelSize, 250);
    });
    root.querySelector('.kt-tabs').addEventListener('wheel', event => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        root.querySelector('.kt-tabs').scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false });

    updateApiState();
    setTab(state.tab);
    return root;
  }

  function togglePanel(force) {
    const root = state.root || createPanel();
    const shouldOpen = typeof force === 'boolean' ? force : !root.classList.contains('kt-open');
    root.classList.toggle('kt-open', shouldOpen);
    if (shouldOpen) {
      state.context = getPageContext();
      setTab(state.tab);
    }
  }

  async function updateApiState() {
    if (!state.root) return;
    const node = state.root.querySelector('.kt-api-state');
    if (!state.settings?.youtubeApiKey) {
      node.className = 'kt-api-state kt-api-off';
      node.innerHTML = '<i></i> YouTube API не подключён';
      return;
    }
    node.className = 'kt-api-state kt-api-wait';
    node.innerHTML = '<i></i> Проверяю YouTube API…';
    const response = await sendMessage({ type: 'api:test' }).catch(error => ({ ok: false, error: { message: error.message } }));
    if (response?.ok) {
      node.className = 'kt-api-state kt-api-on';
      node.innerHTML = '<i></i> YouTube API работает';
    } else {
      node.className = 'kt-api-state kt-api-off';
      node.innerHTML = `<i></i> ${escapeHtml(apiErrorText(response?.error))}`;
    }
  }

  function setTab(tab) {
    state.tab = tab;
    if (!state.root) return;
    state.root.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    const renderers = {
      overview: renderOverview,
      twins: renderTwins,
      channels: renderChannels,
      dna: renderDna,
      gaps: renderGaps,
      ideas: renderIdeas,
      trends: renderTrends,
      saved: renderSaved
    };
    (renderers[tab] || renderOverview)();
  }

  function setMain(html) {
    const main = state.root?.querySelector('.kt-main');
    if (main) main.innerHTML = html;
  }

  function loading(title = 'Получаю данные YouTube…') {
    setMain(`<div class="kt-loading"><span class="kt-spinner"></span><strong>${escapeHtml(title)}</strong><small>KirillTube не скрывает ошибки: если API отклонит запрос, причина появится здесь.</small></div>`);
  }

  function renderError(error, query = '') {
    const text = apiErrorText(error);
    setMain(`
      <section class="kt-section">
        <div class="kt-error-card">
          <strong>Поиск не выполнен</strong>
          <p>${escapeHtml(text)}</p>
          <code>${escapeHtml(error?.reason || 'unknown')}</code>
          <div class="kt-actions">
            <button class="kt-primary" data-action="retry">Повторить</button>
            <button data-action="settings">Проверить API-ключ</button>
            ${query ? `<button data-action="youtube-search" data-query="${escapeHtml(query)}">Открыть поиск YouTube</button>` : ''}
          </div>
        </div>
      </section>
    `);
  }

  async function hydrateVideos(ids) {
    ids = unique(ids).slice(0, 50);
    if (!ids.length) return [];
    const videoData = await api('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
    const channelIds = unique((videoData.items || []).map(item => item.snippet?.channelId));
    let channels = [];
    if (channelIds.length) {
      const channelData = await api('channels', { part: 'snippet,statistics,contentDetails', id: channelIds.join(','), maxResults: 50 });
      channels = channelData.items || [];
    }
    const channelMap = new Map(channels.map(item => [item.id, item]));
    return (videoData.items || []).map(item => {
      const channel = channelMap.get(item.snippet?.channelId);
      return {
        id: item.id,
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        tags: item.snippet?.tags || [],
        thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
        publishedAt: item.snippet?.publishedAt || '',
        channelId: item.snippet?.channelId || '',
        channelTitle: item.snippet?.channelTitle || channel?.snippet?.title || '',
        views: Number(item.statistics?.viewCount || 0),
        likes: Number(item.statistics?.likeCount || 0),
        comments: Number(item.statistics?.commentCount || 0),
        duration: parseDuration(item.contentDetails?.duration),
        subscribers: Number(channel?.statistics?.subscriberCount || 0),
        hiddenSubscribers: Boolean(channel?.statistics?.hiddenSubscriberCount),
        channelThumbnail: channel?.snippet?.thumbnails?.default?.url || '',
        channelDescription: channel?.snippet?.description || '',
        uploadsPlaylist: channel?.contentDetails?.relatedPlaylists?.uploads || ''
      };
    });
  }

  async function searchVideos(query, options = {}) {
    const normalized = normalizeText(query);
    if (!normalized) throw Object.assign(new Error('Введите тему для поиска'), { reason: 'emptyQuery' });
    const key = JSON.stringify({ q: normalized, order: options.order || 'relevance', publishedAfter: options.publishedAfter || '', limit: options.limit || state.settings.resultLimit });
    if (state.searchCache.has(key) && !options.force) return state.searchCache.get(key);

    const limit = clamp(options.limit || state.settings.resultLimit || 24, 5, 50);
    const baseParams = {
      part: 'snippet',
      type: 'video',
      q: normalized,
      maxResults: limit,
      order: options.order || 'relevance',
      safeSearch: 'none',
      relevanceLanguage: state.settings.locale || 'ru'
    };
    if (options.publishedAfter) baseParams.publishedAfter = options.publishedAfter;
    if (options.videoDuration) baseParams.videoDuration = options.videoDuration;

    let searchData = await api('search', baseParams);
    let strategy = 'точная тема';
    let ids = (searchData.items || []).map(item => item.id?.videoId).filter(Boolean);

    if (!ids.length) {
      const tokens = unique(words(normalized)).slice(0, 5);
      if (tokens.length > 1) {
        const fallbackQuery = tokens.join(' | ');
        searchData = await api('search', { ...baseParams, q: fallbackQuery });
        ids = (searchData.items || []).map(item => item.id?.videoId).filter(Boolean);
        strategy = 'расширенный поиск по словам';
      }
    }

    const videos = await hydrateVideos(ids);
    videos.forEach(item => {
      item.similarity = similarity(normalized, item);
      item.viewsPerDay = viewsPerDay(item);
      item.engagement = item.views ? ((item.likes + item.comments * 2) / item.views) * 100 : 0;
      item.outlierProxy = item.subscribers ? item.views / Math.max(1, item.subscribers) : 0;
    });
    const result = { query: normalized, videos, strategy, totalResults: Number(searchData.pageInfo?.totalResults || videos.length) };
    state.searchCache.set(key, result);
    return result;
  }

  async function getCurrentVideo() {
    state.context = getPageContext();
    if (!state.context.videoId) return null;
    if (state.currentVideo?.id === state.context.videoId) return state.currentVideo;
    const items = await hydrateVideos([state.context.videoId]);
    state.currentVideo = items[0] || null;
    if (state.currentVideo) {
      state.context.channelId = state.currentVideo.channelId;
      state.context.channelName = state.currentVideo.channelTitle;
      state.context.tags = state.currentVideo.tags;
      state.context.description = state.currentVideo.description;
      state.context.suggestedQuery = unique(words(`${state.currentVideo.title} ${(state.currentVideo.tags || []).join(' ')}`).slice(0, 6)).join(' ');
    }
    return state.currentVideo;
  }

  function renderOverview() {
    state.context = getPageContext();
    const context = state.context;
    const hasVideo = Boolean(context.videoId);
    setMain(`
      <section class="kt-hero">
        <span class="kt-eyebrow">KIRILLTUBE 1.2</span>
        <h2>${hasVideo ? 'Разбор текущего видео' : 'Откройте видео YouTube'}</h2>
        <p>${hasVideo ? escapeHtml(context.title) : 'На странице ролика KirillTube определит тему, найдёт видео-близнецы, конкурентов и свободные идеи.'}</p>
        <div class="kt-actions">
          ${hasVideo ? '<button class="kt-primary" data-action="analyze-current">Анализировать</button>' : ''}
          <button data-tab="twins">Найти видео-близнецы</button>
          <button data-tab="channels">Похожие каналы</button>
        </div>
      </section>
      <section class="kt-grid kt-grid-2">
        <article class="kt-metric"><small>Title Score</small><strong>${titleScore(context.title)}/100</strong><span>${context.title.length || 0} символов</span></article>
        <article class="kt-metric"><small>Ключевые слова</small><strong>${words(context.suggestedQuery).length}</strong><span>${escapeHtml(words(context.suggestedQuery).slice(0, 4).join(', ') || 'откройте ролик')}</span></article>
      </section>
      <section class="kt-section">
        <div class="kt-section-head"><div><h3>Быстрый старт</h3><p>KirillTube использует публичные данные YouTube и показывает реальные ошибки API.</p></div></div>
        <div class="kt-command-grid">
          <button data-tab="twins"><b>Видео-близнецы</b><span>По теме, тегам и эффективности</span></button>
          <button data-tab="dna"><b>ДНК канала</b><span>Что работает у автора лучше всего</span></button>
          <button data-tab="gaps"><b>Content Gap</b><span>Темы конкурентов, которых нет у канала</span></button>
          <button data-tab="ideas"><b>Idea Studio</b><span>Заголовки, обложка и структура</span></button>
        </div>
      </section>
      <section class="kt-section kt-current-details" hidden></section>
    `);
  }

  async function analyzeCurrent() {
    if (!state.context?.videoId) return;
    const target = state.root.querySelector('.kt-current-details');
    target.hidden = false;
    target.innerHTML = '<div class="kt-inline-loader"><span class="kt-spinner"></span> Получаю точную публичную статистику…</div>';
    try {
      const item = await getCurrentVideo();
      if (!item) throw new Error('Видео не найдено через API');
      const vpd = viewsPerDay(item);
      target.innerHTML = `
        <div class="kt-section-head"><div><h3>Точная статистика</h3><p>Публичные данные YouTube Data API v3</p></div></div>
        <div class="kt-grid kt-grid-3">
          <article class="kt-metric"><small>Просмотры</small><strong>${formatNumber(item.views)}</strong><span>${ageLabel(item.publishedAt)}</span></article>
          <article class="kt-metric"><small>Просмотров в день</small><strong>${formatNumber(vpd)}</strong><span>средняя скорость</span></article>
          <article class="kt-metric"><small>Видео / подписчики</small><strong>${item.subscribers ? item.outlierProxy.toFixed(2) + '×' : '—'}</strong><span>${item.subscribers ? formatNumber(item.subscribers) + ' подписчиков' : 'скрыто'}</span></article>
        </div>
        <div class="kt-tags">${(item.tags || []).slice(0, 14).map(tag => `<span>${escapeHtml(tag)}</span>`).join('') || '<span>Теги не опубликованы</span>'}</div>
      `;
    } catch (error) {
      target.innerHTML = `<div class="kt-error-inline"><strong>Не удалось получить видео</strong><span>${escapeHtml(apiErrorText(error))}</span></div>`;
    }
  }

  function searchShell(title, description, buttonLabel, extra = '') {
    const query = state.context?.suggestedQuery || state.context?.title || '';
    return `
      <section class="kt-section">
        <div class="kt-section-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div></div>
        <div class="kt-search-row">
          <input data-search-input value="${escapeHtml(query)}" placeholder="Введите тему или ключевые слова">
          ${extra}
          <button class="kt-primary" data-action="run-search">${escapeHtml(buttonLabel)}</button>
        </div>
        <div class="kt-search-status">Введите тему и запустите поиск.</div>
        <div class="kt-results"></div>
      </section>
    `;
  }

  function renderTwins() {
    state.context = getPageContext();
    setMain(searchShell('Видео-близнецы', 'Похожие ролики по теме, ключевым словам, открытым тегам и эффективности.', 'Найти похожие', `
      <select data-sort-mode title="Сортировка">
        <option value="similarity">По сходству</option>
        <option value="outlier">По аномальности</option>
        <option value="velocity">По скорости</option>
        <option value="fresh">Сначала свежие</option>
      </select>
    `));
  }

  function videoCard(item) {
    return `
      <article class="kt-video-card">
        <button class="kt-thumb" data-action="open-video" data-video-id="${escapeHtml(item.id)}">
          <img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy"><span>${durationLabel(item.duration)}</span>
        </button>
        <div class="kt-video-body">
          <button class="kt-title-link" data-action="open-video" data-video-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>
          <p>${escapeHtml(item.channelTitle)}</p>
          <div class="kt-mini-metrics">
            <span>${formatNumber(item.views)} просмотров</span><span>${ageLabel(item.publishedAt)}</span><span>${formatNumber(item.viewsPerDay)}/день</span>
          </div>
          <div class="kt-score-row"><b>${item.similarity}% сходства</b><span>${item.outlierProxy ? item.outlierProxy.toFixed(2) + '× к подписчикам' : 'сравнение недоступно'}</span></div>
          <div class="kt-card-actions"><button data-action="save-video" data-id="${escapeHtml(item.id)}">Сохранить</button><button data-action="use-idea" data-title="${escapeHtml(item.title)}">В студию</button></div>
        </div>
      </article>
    `;
  }

  async function runTwinSearch(force = false) {
    const input = state.root.querySelector('[data-search-input]');
    const sort = state.root.querySelector('[data-sort-mode]')?.value || 'similarity';
    const query = input?.value?.trim() || '';
    const status = state.root.querySelector('.kt-search-status');
    const results = state.root.querySelector('.kt-results');
    if (!query) { status.textContent = 'Введите тему.'; return; }
    status.innerHTML = '<span class="kt-spinner kt-spinner-small"></span> YouTube ищет ролики…';
    results.innerHTML = '';
    try {
      const found = await searchVideos(query, { force });
      let videos = found.videos.filter(item => item.id !== state.context?.videoId);
      if (sort === 'similarity') videos.sort((a, b) => b.similarity - a.similarity || b.viewsPerDay - a.viewsPerDay);
      if (sort === 'outlier') videos.sort((a, b) => b.outlierProxy - a.outlierProxy || b.similarity - a.similarity);
      if (sort === 'velocity') videos.sort((a, b) => b.viewsPerDay - a.viewsPerDay);
      if (sort === 'fresh') videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      status.innerHTML = `<b>${videos.length} похожих видео</b><span>Стратегия: ${escapeHtml(found.strategy)} · найдено YouTube: ${formatNumber(found.totalResults)}</span>`;
      if (!videos.length) {
        results.innerHTML = `
          <div class="kt-empty">
            <strong>YouTube вернул 0 видео</strong>
            <p>Ключ работает, но по этому запросу API не отдал результатов. Попробуйте более короткую тему либо откройте обычный поиск YouTube.</p>
            <button data-action="youtube-search" data-query="${escapeHtml(query)}">Открыть поиск YouTube</button>
          </div>`;
        return;
      }
      state.lastVideos = videos;
      results.innerHTML = `<div class="kt-video-list">${videos.map(videoCard).join('')}</div>`;
    } catch (error) {
      renderError(error, query);
    }
  }

  function renderChannels() {
    state.context = getPageContext();
    setMain(searchShell('Похожие каналы', 'KirillTube собирает каналы из релевантных роликов и оценивает тематическое сходство.', 'Найти каналы'));
  }

  function channelCards(videos, query) {
    const grouped = new Map();
    videos.forEach(video => {
      const entry = grouped.get(video.channelId) || {
        id: video.channelId, title: video.channelTitle, thumbnail: video.channelThumbnail,
        subscribers: video.subscribers, description: video.channelDescription, videos: [], similarities: []
      };
      entry.videos.push(video);
      entry.similarities.push(video.similarity);
      grouped.set(video.channelId, entry);
    });
    return [...grouped.values()].map(channel => {
      channel.similarity = Math.round(Math.max(...channel.similarities, 0) * 0.65 + (channel.similarities.reduce((a,b)=>a+b,0) / channel.similarities.length) * 0.35);
      channel.totalViews = channel.videos.reduce((sum, video) => sum + video.views, 0);
      channel.best = channel.videos.sort((a,b)=>b.similarity-a.similarity)[0];
      return channel;
    }).sort((a,b)=>b.similarity-a.similarity || b.videos.length-a.videos.length);
  }

  async function runChannelSearch(force = false) {
    const query = state.root.querySelector('[data-search-input]')?.value?.trim() || '';
    const status = state.root.querySelector('.kt-search-status');
    const results = state.root.querySelector('.kt-results');
    if (!query) { status.textContent = 'Введите тему.'; return; }
    status.innerHTML = '<span class="kt-spinner kt-spinner-small"></span> Анализирую релевантные каналы…';
    results.innerHTML = '';
    try {
      const found = await searchVideos(query, { force, limit: 40 });
      const channels = channelCards(found.videos, query).filter(channel => channel.id !== state.context?.channelId).slice(0, 20);
      status.innerHTML = `<b>${channels.length} похожих каналов</b><span>На основе ${found.videos.length} релевантных роликов</span>`;
      results.innerHTML = channels.length ? `<div class="kt-channel-list">${channels.map(channel => `
        <article class="kt-channel-card">
          <img src="${escapeHtml(channel.thumbnail)}" alt="" loading="lazy">
          <div><h3>${escapeHtml(channel.title)}</h3><p>${formatNumber(channel.subscribers)} подписчиков · ${channel.videos.length} совпадений</p><small>${escapeHtml(channel.best?.title || '')}</small></div>
          <strong>${channel.similarity}%</strong>
          <div class="kt-card-actions"><button data-action="open-channel" data-channel-id="${escapeHtml(channel.id)}">Открыть</button><button data-action="save-channel" data-channel-id="${escapeHtml(channel.id)}" data-title="${escapeHtml(channel.title)}">Следить</button></div>
        </article>`).join('')}</div>` : '<div class="kt-empty"><strong>Каналы не найдены</strong><p>Попробуйте сократить запрос до двух–трёх ключевых слов.</p></div>';
    } catch (error) {
      renderError(error, query);
    }
  }

  async function loadChannelDna(force = false) {
    const current = await getCurrentVideo();
    const channelId = current?.channelId || state.context?.channelId;
    if (!channelId) throw Object.assign(new Error('Откройте видео нужного канала'), { reason: 'channelNotDetected' });
    if (state.dna?.channelId === channelId && !force) return state.dna;
    const channelData = await api('channels', { part: 'snippet,statistics,contentDetails', id: channelId, maxResults: 1 });
    const channel = channelData.items?.[0];
    const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) throw new Error('YouTube не вернул плейлист загрузок канала');
    const playlist = await api('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: 50 });
    const ids = (playlist.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
    const videos = await hydrateVideos(ids);
    const viewMedian = median(videos.map(video => video.views));
    videos.forEach(video => {
      video.outlier = viewMedian ? video.views / viewMedian : 0;
      video.viewsPerDay = viewsPerDay(video);
    });
    const topVideos = [...videos].sort((a,b)=>b.outlier-a.outlier).slice(0, 8);
    const topKeywords = keywordsFromTexts(topVideos.map(video => `${video.title} ${(video.tags || []).join(' ')}`), 16);
    const avgDuration = videos.length ? videos.reduce((sum, video) => sum + video.duration, 0) / videos.length : 0;
    const publishDates = videos.map(video => new Date(video.publishedAt).getTime()).filter(Number.isFinite).sort((a,b)=>b-a);
    const intervals = publishDates.slice(0,-1).map((time,index)=>(time-publishDates[index+1])/86400000).filter(value=>value>0);
    const frequency = median(intervals);
    state.dna = {
      channelId,
      title: channel.snippet?.title || current?.channelTitle || '',
      description: channel.snippet?.description || '',
      thumbnail: channel.snippet?.thumbnails?.medium?.url || '',
      subscribers: Number(channel.statistics?.subscriberCount || 0),
      totalViews: Number(channel.statistics?.viewCount || 0),
      videoCount: Number(channel.statistics?.videoCount || videos.length),
      videos,
      topVideos,
      topKeywords,
      viewMedian,
      avgDuration,
      frequency
    };
    return state.dna;
  }

  function renderDna() {
    setMain(`
      <section class="kt-section">
        <div class="kt-section-head"><div><h2>ДНК канала</h2><p>Анализ последних 50 публичных роликов текущего канала.</p></div><button class="kt-primary" data-action="load-dna">Построить ДНК</button></div>
        <div class="kt-results"><div class="kt-empty"><strong>Откройте видео нужного канала</strong><p>KirillTube найдёт сильные темы, медиану просмотров, аномальные ролики и рабочую формулу.</p></div></div>
      </section>`);
  }

  async function runDna(force = false) {
    loading('Строю ДНК канала…');
    try {
      const dna = await loadChannelDna(force);
      setMain(`
        <section class="kt-section">
          <div class="kt-profile"><img src="${escapeHtml(dna.thumbnail)}" alt=""><div><span class="kt-eyebrow">ДНК КАНАЛА</span><h2>${escapeHtml(dna.title)}</h2><p>${formatNumber(dna.subscribers)} подписчиков · ${formatNumber(dna.videoCount)} видео</p></div><button data-action="load-dna" data-force="1">Обновить</button></div>
          <div class="kt-grid kt-grid-4">
            <article class="kt-metric"><small>Медиана просмотров</small><strong>${formatNumber(dna.viewMedian)}</strong><span>последние ${dna.videos.length} роликов</span></article>
            <article class="kt-metric"><small>Средняя длина</small><strong>${durationLabel(dna.avgDuration)}</strong><span>рабочий диапазон</span></article>
            <article class="kt-metric"><small>Публикации</small><strong>${dna.frequency ? `раз в ${dna.frequency.toFixed(1)} дн.` : '—'}</strong><span>медианный интервал</span></article>
            <article class="kt-metric"><small>Лучший outlier</small><strong>${dna.topVideos[0]?.outlier ? dna.topVideos[0].outlier.toFixed(1)+'×' : '—'}</strong><span>к медиане канала</span></article>
          </div>
          <div class="kt-grid kt-grid-2">
            <article class="kt-insight"><h3>Сильные темы</h3><div class="kt-tags">${dna.topKeywords.map(item=>`<span>${escapeHtml(item.word)} <b>${item.count}</b></span>`).join('')}</div></article>
            <article class="kt-insight"><h3>Формула канала</h3><p>${escapeHtml(buildChannelFormula(dna))}</p><button data-action="dna-to-ideas">Создать следующую идею</button></article>
          </div>
          <div class="kt-section-head"><div><h3>Ролики-аномалии</h3><p>Видео, которые сильнее всего превысили обычный результат канала.</p></div></div>
          <div class="kt-video-list">${dna.topVideos.map(video => { video.similarity = Math.min(100, Math.round(video.outlier * 18)); return videoCard(video); }).join('')}</div>
        </section>`);
    } catch (error) {
      renderError(error);
    }
  }

  function buildChannelFormula(dna) {
    const wordsList = dna.topKeywords.slice(0, 4).map(item => item.word);
    const patterns = dna.topVideos.map(video => video.title).join(' ');
    const format = /сравн|против/i.test(patterns) ? 'сравнение' : /тест|провер/i.test(patterns) ? 'практический тест' : /как|инструк/i.test(patterns) ? 'пошаговая инструкция' : 'конкретная проблема и доказуемый результат';
    return `${format} + темы «${wordsList.join(' / ')}» + длина около ${durationLabel(dna.avgDuration)} + ясное обещание результата в заголовке.`;
  }

  function renderGaps() {
    state.context = getPageContext();
    setMain(`
      <section class="kt-section">
        <div class="kt-section-head"><div><h2>Content Gap</h2><p>Темы релевантных конкурентов, которых нет в последних роликах текущего канала.</p></div><button class="kt-primary" data-action="run-gaps">Найти пробелы</button></div>
        <div class="kt-search-row"><input data-search-input value="${escapeHtml(state.context.suggestedQuery)}" placeholder="Основная тема канала"></div>
        <div class="kt-results"><div class="kt-empty"><strong>Сравнение ещё не запущено</strong><p>Потребуются ДНК текущего канала и один поиск релевантных видео.</p></div></div>
      </section>`);
  }

  async function runGaps() {
    const query = state.root.querySelector('[data-search-input]')?.value?.trim() || state.context?.suggestedQuery || '';
    loading('Сравниваю темы канала и конкурентов…');
    try {
      const [dna, market] = await Promise.all([loadChannelDna(false), searchVideos(query, { limit: 40 })]);
      const ownWords = new Set(keywordsFromTexts(dna.videos.map(video => `${video.title} ${(video.tags || []).join(' ')}`), 120).map(item => item.word));
      const marketKeywords = keywordsFromTexts(market.videos.filter(video => video.channelId !== dna.channelId).map(video => `${video.title} ${(video.tags || []).join(' ')}`), 80);
      const gaps = marketKeywords.filter(item => !ownWords.has(item.word) && item.count >= 2).slice(0, 18);
      const opportunities = gaps.map(gap => {
        const examples = market.videos.filter(video => words(`${video.title} ${(video.tags || []).join(' ')}`).includes(gap.word)).sort((a,b)=>b.viewsPerDay-a.viewsPerDay).slice(0,3);
        const score = clamp(45 + gap.count * 6 + Math.log10((examples[0]?.viewsPerDay || 0) + 1) * 7, 0, 99);
        return { ...gap, examples, score: Math.round(score) };
      }).sort((a,b)=>b.score-a.score);
      setMain(`
        <section class="kt-section">
          <div class="kt-section-head"><div><h2>Найдено ${opportunities.length} пробелов</h2><p>Сравнены ${dna.videos.length} роликов канала и ${market.videos.length} рыночных примеров.</p></div><button data-action="run-gaps">Обновить</button></div>
          <div class="kt-opportunity-list">${opportunities.map(item=>`
            <article class="kt-opportunity">
              <strong>${item.score}</strong><div><h3>${escapeHtml(item.word)}</h3><p>${item.count} упоминаний у конкурентов · ${item.examples.length} сильных примера</p><small>${escapeHtml(item.examples.map(video=>video.title).join(' · '))}</small></div><button data-action="gap-to-ideas" data-topic="${escapeHtml(item.word)}">Развить</button>
            </article>`).join('') || '<div class="kt-empty"><strong>Явных пробелов не найдено</strong><p>Попробуйте более широкую основную тему канала.</p></div>'}</div>
        </section>`);
    } catch (error) {
      renderError(error, query);
    }
  }

  function renderIdeas(seed = '') {
    state.context = getPageContext();
    const topic = seed || state.ideaSeed || state.context.suggestedQuery || '';
    setMain(`
      <section class="kt-section">
        <div class="kt-section-head"><div><h2>Idea Studio</h2><p>Готовая концепция, заголовки, обложка и структура без дополнительного AI-ключа.</p></div></div>
        <div class="kt-search-row"><input data-search-input value="${escapeHtml(topic)}" placeholder="Тема будущего видео"><button class="kt-primary" data-action="generate-idea">Создать концепцию</button></div>
        <div class="kt-results"><div class="kt-empty"><strong>Введите тему</strong><p>Лучший результат получается из Content Gap, ДНК канала или найденного ролика.</p></div></div>
      </section>`);
  }

  function generateIdea(topic) {
    const clean = normalizeText(topic);
    const noun = clean || 'ваша тема';
    const titles = [
      `Проверили ${noun} в реальных условиях — вот результат`,
      `${noun}: главные ошибки, которые допускают почти все`,
      `Я протестировал ${noun}, чтобы вам не пришлось`,
      `Правда о ${noun}: что показывают реальные тесты`,
      `${noun} — дешёвый вариант против дорогого`,
      `Как выбрать ${noun} и не потерять деньги`,
      `5 вещей о ${noun}, о которых обычно молчат`,
      `${noun}: полный разбор за 10 минут`
    ].map(title => ({ title, score: titleScore(title) })).sort((a,b)=>b.score-a.score);
    return {
      topic: noun,
      concept: `Взять конкретную проблему зрителя вокруг темы «${noun}», провести наглядную проверку, показать измеримый результат и закончить практическим выводом, который можно повторить.` ,
      titles,
      thumbnail: `Один крупный объект, связанный с темой «${noun}», на контрастном фоне. Слева — проблема, справа — результат. Не более 2–4 слов: «РЕАЛЬНЫЙ ТЕСТ» или «ВОТ ЧТО ВЫШЛО».`,
      outline: [
        ['00:00','Сильный результат или проблема без вступления'],
        ['00:20','Что именно проверяем и почему это важно'],
        ['01:10','Условия теста и критерии честной оценки'],
        ['03:00','Первый практический результат'],
        ['05:30','Неожиданная находка или сравнение'],
        ['08:00','Вывод: кому подходит и что делать зрителю']
      ]
    };
  }

  function runIdeaGeneration() {
    const topic = state.root.querySelector('[data-search-input]')?.value?.trim() || '';
    if (!topic) return;
    const idea = generateIdea(topic);
    const results = state.root.querySelector('.kt-results');
    results.innerHTML = `
      <article class="kt-idea-block"><span class="kt-eyebrow">КОНЦЕПЦИЯ</span><p>${escapeHtml(idea.concept)}</p></article>
      <article class="kt-idea-block"><div class="kt-section-head"><div><h3>Заголовки</h3><p>Оценка — локальная эвристика упаковки, не прогноз просмотров.</p></div></div><div class="kt-title-list">${idea.titles.map(item=>`<button data-action="copy-text" data-text="${escapeHtml(item.title)}"><b>${item.score}</b><span>${escapeHtml(item.title)}</span><i>Копировать</i></button>`).join('')}</div></article>
      <article class="kt-idea-block"><span class="kt-eyebrow">ОБЛОЖКА</span><p>${escapeHtml(idea.thumbnail)}</p></article>
      <article class="kt-idea-block"><span class="kt-eyebrow">СТРУКТУРА</span><div class="kt-outline">${idea.outline.map(([time,text])=>`<div><b>${time}</b><span>${escapeHtml(text)}</span></div>`).join('')}</div></article>
      <button class="kt-primary kt-wide" data-action="save-idea" data-topic="${escapeHtml(idea.topic)}">Сохранить концепцию</button>`;
    state.generatedIdea = idea;
  }

  function renderTrends() {
    state.context = getPageContext();
    setMain(searchShell('Trend Radar', 'Свежие ролики по теме, ранжированные по фактической скорости набора просмотров.', 'Найти сигнал', '<select data-days><option value="7">7 дней</option><option value="30" selected>30 дней</option><option value="90">90 дней</option></select>'));
  }

  async function runTrendSearch(force = false) {
    const query = state.root.querySelector('[data-search-input]')?.value?.trim() || '';
    const days = Number(state.root.querySelector('[data-days]')?.value || 30);
    const status = state.root.querySelector('.kt-search-status');
    const results = state.root.querySelector('.kt-results');
    if (!query) { status.textContent = 'Введите тему.'; return; }
    status.innerHTML = '<span class="kt-spinner kt-spinner-small"></span> Ищу свежие сигналы…';
    try {
      const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
      const found = await searchVideos(query, { force, order: 'date', publishedAfter, limit: 40 });
      const speeds = found.videos.map(video=>video.viewsPerDay);
      const speedMedian = median(speeds) || 1;
      const videos = found.videos.map(video=>({ ...video, trendScore: clamp(Math.round(45 + Math.log10(video.viewsPerDay + 1) * 10 + Math.min(28, video.viewsPerDay / speedMedian * 6)), 0, 99) })).sort((a,b)=>b.trendScore-a.trendScore);
      status.innerHTML = `<b>${videos.length} свежих сигналов</b><span>Окно: ${days} дней · медиана ${formatNumber(speedMedian)} просмотров/день</span>`;
      results.innerHTML = `<div class="kt-trend-list">${videos.map(video=>`
        <article class="kt-trend-card"><strong>${video.trendScore}</strong><img src="${escapeHtml(video.thumbnail)}" alt=""><div><button data-action="open-video" data-video-id="${escapeHtml(video.id)}">${escapeHtml(video.title)}</button><p>${escapeHtml(video.channelTitle)} · ${ageLabel(video.publishedAt)}</p><span>${formatNumber(video.viewsPerDay)} просмотров/день · ${(video.viewsPerDay/speedMedian).toFixed(1)}× к медиане</span></div><button data-action="use-idea" data-title="${escapeHtml(video.title)}">Идея</button></article>`).join('')}</div>`;
    } catch (error) {
      renderError(error, query);
    }
  }

  async function getSaved() {
    const response = await sendMessage({ type: 'settings:get' });
    return response?.settings?.savedItems || [];
  }

  async function saveItem(item) {
    const saved = await getSaved();
    const id = item.id || `${item.type}-${Date.now()}`;
    const next = [{ ...item, id, savedAt: new Date().toISOString() }, ...saved.filter(existing => existing.id !== id)].slice(0, 200);
    await sendMessage({ type: 'settings:set', values: { savedItems: next } });
    toast('Сохранено');
  }

  async function renderSaved() {
    setMain('<div class="kt-loading"><span class="kt-spinner"></span><strong>Загружаю сохранённое…</strong></div>');
    const saved = await getSaved();
    setMain(`
      <section class="kt-section">
        <div class="kt-section-head"><div><h2>Сохранённое</h2><p>${saved.length} материалов: ролики, каналы и концепции.</p></div>${saved.length ? '<button data-action="clear-saved">Очистить</button>' : ''}</div>
        <div class="kt-saved-list">${saved.map(item=>`
          <article><span>${item.type === 'video' ? 'ВИДЕО' : item.type === 'channel' ? 'КАНАЛ' : 'ИДЕЯ'}</span><div><h3>${escapeHtml(item.title || item.topic || 'Без названия')}</h3><p>${escapeHtml(item.subtitle || item.concept || '')}</p></div>${item.url ? `<button data-action="open-url" data-url="${escapeHtml(item.url)}">Открыть</button>` : ''}<button data-action="remove-saved" data-id="${escapeHtml(item.id)}">×</button></article>`).join('') || '<div class="kt-empty"><strong>Пока пусто</strong><p>Сохраняйте найденные ролики, каналы и идеи.</p></div>'}</div>
      </section>`);
  }

  async function removeSaved(id) {
    const saved = await getSaved();
    await sendMessage({ type: 'settings:set', values: { savedItems: saved.filter(item => item.id !== id) } });
    renderSaved();
  }

  async function clearSaved() {
    await sendMessage({ type: 'settings:set', values: { savedItems: [] } });
    renderSaved();
  }

  function toast(text) {
    if (!state.root) return;
    let node = state.root.querySelector('.kt-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'kt-toast';
      state.root.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('show');
    setTimeout(() => node.classList.remove('show'), 1600);
  }

  function runCurrentSearch(force = false) {
    if (state.tab === 'twins') return runTwinSearch(force);
    if (state.tab === 'channels') return runChannelSearch(force);
    if (state.tab === 'trends') return runTrendSearch(force);
    if (state.tab === 'ideas') return runIdeaGeneration();
  }

  async function handlePanelClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tab) { setTab(button.dataset.tab); return; }
    const action = button.dataset.action;
    if (!action) return;

    if (action === 'close') return togglePanel(false);
    if (action === 'fullscreen') return state.root.classList.toggle('kt-fullscreen');
    if (action === 'refresh') { state.searchCache.clear(); state.currentVideo = null; state.dna = null; state.context = getPageContext(); setTab(state.tab); updateApiState(); return; }
    if (action === 'settings') { await sendMessage({ type: 'options:open' }); return; }
    if (action === 'zoom-in' || action === 'zoom-out') {
      const next = clamp((state.settings.textScale || 100) + (action === 'zoom-in' ? 10 : -10), 80, 150);
      state.settings.textScale = next;
      state.root.style.setProperty('--kt-scale', String(next / 100));
      await sendMessage({ type: 'settings:set', values: { textScale: next } });
      return;
    }
    if (action === 'analyze-current') return analyzeCurrent();
    if (action === 'run-search') return runCurrentSearch(false);
    if (action === 'retry') return runCurrentSearch(true);
    if (action === 'load-dna') return runDna(button.dataset.force === '1');
    if (action === 'run-gaps') return runGaps();
    if (action === 'generate-idea') return runIdeaGeneration();
    if (action === 'dna-to-ideas') {
      state.ideaSeed = state.dna?.topKeywords?.slice(0,3).map(item=>item.word).join(' ') || '';
      setTab('ideas');
      return;
    }
    if (action === 'gap-to-ideas') { state.ideaSeed = button.dataset.topic || ''; setTab('ideas'); return; }
    if (action === 'use-idea') { state.ideaSeed = button.dataset.title || ''; setTab('ideas'); return; }
    if (action === 'youtube-search') {
      const query = button.dataset.query || state.root.querySelector('[data-search-input]')?.value || '';
      await sendMessage({ type: 'tab:open', url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` });
      return;
    }
    if (action === 'open-video') return sendMessage({ type: 'tab:open', url: `https://www.youtube.com/watch?v=${encodeURIComponent(button.dataset.videoId)}` });
    if (action === 'open-channel') return sendMessage({ type: 'tab:open', url: `https://www.youtube.com/channel/${encodeURIComponent(button.dataset.channelId)}` });
    if (action === 'open-url') return sendMessage({ type: 'tab:open', url: button.dataset.url });
    if (action === 'copy-text') { await navigator.clipboard.writeText(button.dataset.text || ''); toast('Скопировано'); return; }
    if (action === 'save-video') {
      const item = (state.lastVideos || []).find(video => video.id === button.dataset.id);
      if (item) await saveItem({ type: 'video', id: item.id, title: item.title, subtitle: `${item.channelTitle} · ${formatNumber(item.views)} просмотров`, url: `https://www.youtube.com/watch?v=${item.id}` });
      return;
    }
    if (action === 'save-channel') return saveItem({ type: 'channel', id: button.dataset.channelId, title: button.dataset.title, url: `https://www.youtube.com/channel/${button.dataset.channelId}` });
    if (action === 'save-idea' && state.generatedIdea) return saveItem({ type: 'idea', title: state.generatedIdea.topic, concept: state.generatedIdea.concept });
    if (action === 'remove-saved') return removeSaved(button.dataset.id);
    if (action === 'clear-saved') return clearSaved();
  }

  function onUrlChange() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    state.context = getPageContext();
    state.currentVideo = null;
    state.dna = null;
    if (state.root?.classList.contains('kt-open')) setTimeout(() => setTab(state.tab), 500);
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'panel:toggle') {
      togglePanel();
      sendResponse?.({ ok: true });
    }
    return true;
  });

  document.addEventListener('keydown', event => {
    if (event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePanel();
    }
  });
  document.addEventListener('yt-navigate-finish', onUrlChange);
  setInterval(onUrlChange, 1200);

  (async () => {
    await loadSettings();
    state.context = getPageContext();
    createPanel();
  })();
})();
