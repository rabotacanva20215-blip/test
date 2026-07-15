(() => {
  'use strict';
  const ext = globalThis.browser || globalThis.chrome;
  const ids = ['youtubeApiKey','locale','regionCode','resultLimit','textScale','panelWidth','panelHeight'];
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

  function setResult(kind, text) {
    const node = $('#apiResult');
    node.className = `notice ${kind || ''}`;
    node.textContent = text;
  }

  function apiError(error) {
    const labels = {
      missingApiKey: 'API-ключ не сохранён.',
      keyInvalid: 'Ключ недействителен.',
      accessNotConfigured: 'В проекте Google Cloud не включён YouTube Data API v3.',
      quotaExceeded: 'Дневная квота API закончилась.',
      dailyLimitExceeded: 'Дневная квота API закончилась.',
      forbidden: 'Google запретил запрос. Проверьте ограничения ключа.',
      ipRefererBlocked: 'Ограничения приложения блокируют запросы расширения.'
    };
    return labels[error?.reason] || error?.message || 'Неизвестная ошибка YouTube API.';
  }

  async function load() {
    const response = await send({ type: 'settings:get' });
    const settings = response?.settings || {};
    ids.forEach(id => {
      const node = document.getElementById(id);
      if (node && settings[id] !== undefined) node.value = settings[id];
    });
    if (settings.youtubeApiKey) testKey();
  }

  async function testKey() {
    const key = $('#youtubeApiKey').value.trim();
    if (!key) {
      setResult('error', 'Вставьте YouTube Data API key.');
      return false;
    }
    setResult('', 'Проверяю ключ через YouTube Data API…');
    const response = await send({ type: 'api:test', apiKey: key }).catch(error => ({ ok: false, error: { message: error.message } }));
    if (response?.ok) {
      setResult('ok', 'Ключ работает. Публичная статистика и поиск доступны.');
      return true;
    }
    setResult('error', apiError(response?.error));
    return false;
  }

  async function save() {
    const values = {
      youtubeApiKey: $('#youtubeApiKey').value.trim(),
      locale: $('#locale').value,
      regionCode: $('#regionCode').value.trim().toUpperCase() || 'RU',
      resultLimit: Number($('#resultLimit').value || 24),
      textScale: Number($('#textScale').value || 100),
      panelWidth: Number($('#panelWidth').value || 580),
      panelHeight: Number($('#panelHeight').value || 760)
    };
    await send({ type: 'settings:set', values });
    $('#saved').textContent = 'Настройки сохранены';
    setTimeout(() => { $('#saved').textContent = ''; }, 1800);
    if (values.youtubeApiKey) await testKey();
  }

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#youtubeApiKey');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('#toggleKey').textContent = visible ? 'Показать ключ' : 'Скрыть ключ';
  });
  $('#testKey').addEventListener('click', testKey);
  $('#save').addEventListener('click', save);
  load();
})();
