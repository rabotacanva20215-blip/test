(() => {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const DEFAULTS = {
    youtubeApiKey: '',
    locale: 'ru',
    regionCode: 'RU',
    resultLimit: 24,
    textScale: 100,
    panelWidth: 580,
    panelHeight: 760,
    theme: 'dark'
  };

  function storageGet(keys) {
    const result = ext.storage.local.get(keys);
    if (result && typeof result.then === 'function') return result;
    return new Promise((resolve, reject) => {
      ext.storage.local.get(keys, value => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(value || {});
      });
    });
  }

  function storageSet(values) {
    const result = ext.storage.local.set(values);
    if (result && typeof result.then === 'function') return result;
    return new Promise((resolve, reject) => {
      ext.storage.local.set(values, () => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  async function getSettings() {
    const stored = await storageGet(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  }

  function parseApiError(response, body) {
    const apiError = body && body.error;
    const first = apiError && Array.isArray(apiError.errors) ? apiError.errors[0] : null;
    const reason = first?.reason || apiError?.status || `HTTP_${response.status}`;
    const message = apiError?.message || response.statusText || 'YouTube API request failed';
    const error = new Error(message);
    error.name = 'YouTubeApiError';
    error.code = response.status;
    error.reason = reason;
    error.details = body || null;
    return error;
  }

  async function youtubeRequest(resource, params = {}, keyOverride = '') {
    const settings = await getSettings();
    const key = String(keyOverride || settings.youtubeApiKey || '').trim();
    if (!key) {
      const error = new Error('YouTube Data API key не сохранён');
      error.name = 'YouTubeApiError';
      error.reason = 'missingApiKey';
      error.code = 401;
      throw error;
    }

    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    const cleanParams = {};
    for (const [name, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') cleanParams[name] = String(value);
    }
    cleanParams.key = key;
    url.search = new URLSearchParams(cleanParams).toString();

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    if (!response.ok) throw parseApiError(response, body);
    return body || {};
  }

  function serializeError(error) {
    return {
      ok: false,
      error: {
        name: error?.name || 'Error',
        message: error?.message || 'Неизвестная ошибка',
        reason: error?.reason || 'unknown',
        code: Number(error?.code || 0),
        details: error?.details || null
      }
    };
  }

  async function openOptions() {
    if (ext.runtime.openOptionsPage) {
      const result = ext.runtime.openOptionsPage();
      if (result && typeof result.then === 'function') await result;
      return;
    }
    const url = ext.runtime.getURL('options.html');
    const result = ext.tabs.create({ url });
    if (result && typeof result.then === 'function') await result;
  }

  async function sendToActiveTab(message) {
    let tabs;
    const result = ext.tabs.query({ active: true, currentWindow: true });
    if (result && typeof result.then === 'function') tabs = await result;
    else tabs = await new Promise(resolve => ext.tabs.query({ active: true, currentWindow: true }, resolve));
    const tab = tabs && tabs[0];
    if (!tab?.id) return false;
    try {
      const sent = ext.tabs.sendMessage(tab.id, message);
      if (sent && typeof sent.then === 'function') await sent;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function handleMessage(message) {
    const type = message?.type;
    if (type === 'settings:get') return { ok: true, settings: await getSettings() };
    if (type === 'settings:set') {
      await storageSet(message.values || {});
      return { ok: true, settings: await getSettings() };
    }
    if (type === 'api:test') {
      try {
        const data = await youtubeRequest('videos', {
          part: 'snippet,statistics',
          id: 'dQw4w9WgXcQ',
          maxResults: 1
        }, message.apiKey || '');
        return { ok: true, itemCount: Array.isArray(data.items) ? data.items.length : 0 };
      } catch (error) {
        return serializeError(error);
      }
    }
    if (type === 'api:request') {
      try {
        const data = await youtubeRequest(message.resource, message.params || {}, message.apiKey || '');
        return { ok: true, data };
      } catch (error) {
        return serializeError(error);
      }
    }
    if (type === 'options:open') {
      await openOptions();
      return { ok: true };
    }
    if (type === 'panel:toggle-active') {
      return { ok: await sendToActiveTab({ type: 'panel:toggle' }) };
    }
    if (type === 'tab:open') {
      const url = String(message.url || '');
      if (!/^https:\/\//i.test(url)) return { ok: false, error: { message: 'Недопустимая ссылка' } };
      const created = ext.tabs.create({ url });
      if (created && typeof created.then === 'function') await created;
      return { ok: true };
    }
    return { ok: false, error: { message: 'Неизвестная команда' } };
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(handleMessage(message, sender))
      .then(sendResponse)
      .catch(error => sendResponse(serializeError(error)));
    return true;
  });

  if (ext.action?.onClicked) {
    ext.action.onClicked.addListener(() => {
      sendToActiveTab({ type: 'panel:toggle' });
    });
  }
})();
