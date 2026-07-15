(() => {
  'use strict';
  const ext = globalThis.browser || globalThis.chrome;
  const $ = selector => document.querySelector(selector);

  function send(message) {
    const result = ext.runtime.sendMessage(message);
    if (result && typeof result.then === 'function') return result;
    return new Promise((resolve, reject) => {
      ext.runtime.sendMessage(message, response => {
        const error = ext.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function errorText(error) {
    const reason = error?.reason || 'unknown';
    const labels = {
      missingApiKey: 'API-ключ не сохранён',
      keyInvalid: 'Ключ недействителен',
      accessNotConfigured: 'YouTube Data API v3 не включён',
      quotaExceeded: 'Дневная квота закончилась',
      dailyLimitExceeded: 'Дневная квота закончилась',
      forbidden: 'Google отклонил запрос',
      ipRefererBlocked: 'Ограничения ключа блокируют расширение'
    };
    return labels[reason] || error?.message || 'Неизвестная ошибка';
  }

  function setStatus(kind, title, detail) {
    const node = $('#status');
    node.className = `status ${kind || ''}`;
    node.querySelector('strong').textContent = title;
    node.querySelector('span').textContent = detail || '';
  }

  async function testKey(key = '') {
    setStatus('', 'Проверяю YouTube API…', 'Отправляю тестовый запрос');
    const response = await send({ type: 'api:test', apiKey: key }).catch(error => ({ ok: false, error: { message: error.message } }));
    if (response?.ok) setStatus('ok', 'YouTube API работает', 'Поиск и публичная статистика доступны');
    else setStatus('error', 'API не работает', errorText(response?.error));
    return response;
  }

  async function init() {
    const response = await send({ type: 'settings:get' });
    const key = response?.settings?.youtubeApiKey || '';
    $('#apiKey').value = key;
    if (key) await testKey();
    else setStatus('error', 'API не подключён', 'Вставьте ключ Public data и сохраните');
  }

  $('#openPanel').addEventListener('click', async () => {
    const response = await send({ type: 'panel:toggle-active' });
    if (!response?.ok) setStatus('error', 'Откройте YouTube', 'Панель работает на страницах youtube.com');
    else window.close();
  });

  $('#saveKey').addEventListener('click', async () => {
    const key = $('#apiKey').value.trim();
    if (!key) {
      setStatus('error', 'Ключ пустой', 'Вставьте YouTube Data API key');
      return;
    }
    await send({ type: 'settings:set', values: { youtubeApiKey: key } });
    await testKey(key);
  });

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#settings').addEventListener('click', () => send({ type: 'options:open' }));
  init();
})();
