'use strict';

const STORAGE_KEY = 'pagedf:settings';

const DEFAULTS = {
  paper: 'a4',
  orientation: 'portrait',
  margin: 'normal',
  scale: '1',
  printBackground: true,
  screenMedia: true,
  lazyImages: true,
  headerFooter: false,
  saveAs: true
};

const BLOCKED_SCHEME = /^(chrome|brave|edge|devtools|chrome-extension|chrome-search|chrome-untrusted|about|view-source|data|blob|javascript|filesystem):/i;
const WEB_STORE = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

const el = (id) => document.getElementById(id);

let activeTab = null;
let busy = false;
let persistTimer = 0;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const form = el('form');
  form.addEventListener('submit', onSubmit);
  form.addEventListener('change', schedulePersist);
  form.addEventListener('input', schedulePersist);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  applySettings(await loadSettings());

  activeTab = await getActiveTab();
  renderTab(activeTab);
  applyTabState(activeTab);
}

/* ------------------------------------------------------------------ */
/* Ayarlar                                                             */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const store = await chrome.storage.local.get(STORAGE_KEY);
    const saved = store && store[STORAGE_KEY];
    return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
  } catch (_) {
    return Object.assign({}, DEFAULTS);
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void persistSettings(); }, 200);
}

async function persistSettings() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: readSettings() });
  } catch (_) { /* depolama yoksa yoksay */ }
}

function applySettings(settings) {
  setSelectValue('paper', settings.paper, DEFAULTS.paper);
  setSelectValue('scale', settings.scale, DEFAULTS.scale);

  setRadioValue('orientation', settings.orientation, DEFAULTS.orientation);
  setRadioValue('margin', settings.margin, DEFAULTS.margin);

  const toggles = ['printBackground', 'screenMedia', 'lazyImages', 'headerFooter', 'saveAs'];
  for (const name of toggles) {
    const input = document.querySelector(`input[name="${name}"]`);
    if (input) input.checked = Boolean(settings[name]);
  }
}

function setSelectValue(id, value, fallback) {
  const select = el(id);
  if (!select) return;
  const exists = Array.prototype.some.call(select.options, (option) => option.value === String(value));
  select.value = exists ? String(value) : String(fallback);
}

function setRadioValue(name, value, fallback) {
  const inputs = document.querySelectorAll(`input[name="${name}"]`);
  const values = Array.prototype.map.call(inputs, (input) => input.value);
  const target = values.includes(String(value)) ? String(value) : String(fallback);
  for (const input of inputs) input.checked = input.value === target;
}

function readSettings() {
  const orientation = document.querySelector('input[name="orientation"]:checked');
  const margin = document.querySelector('input[name="margin"]:checked');

  const checked = (name, fallback) => {
    const input = document.querySelector(`input[name="${name}"]`);
    return input ? input.checked : fallback;
  };

  return {
    paper: el('paper').value,
    orientation: orientation ? orientation.value : DEFAULTS.orientation,
    margin: margin ? margin.value : DEFAULTS.margin,
    scale: el('scale').value,
    printBackground: checked('printBackground', true),
    screenMedia: checked('screenMedia', true),
    lazyImages: checked('lazyImages', true),
    headerFooter: checked('headerFooter', false),
    saveAs: checked('saveAs', true)
  };
}

/* ------------------------------------------------------------------ */
/* Sekme bilgisi                                                       */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (_) {
    return null;
  }
}

function renderTab(tab) {
  const titleEl = el('pageTitle');
  const hostEl = el('pageHost');

  if (!tab) {
    titleEl.textContent = 'Aktif sekme bulunamadı';
    hostEl.textContent = '';
    return;
  }

  let host = '';
  try {
    const url = new URL(tab.url);
    host = url.protocol === 'file:' ? 'Yerel dosya' : url.hostname.replace(/^www\./, '');
  } catch (_) { /* boş bırak */ }

  titleEl.textContent = tab.title || host || 'Başlıksız sayfa';
  hostEl.textContent = host;
}

function applyTabState(tab) {
  const card = el('pageCard');
  const problem = tabProblem(tab);

  card.classList.toggle('is-blocked', Boolean(problem));

  if (problem) {
    setStatus(problem, 'warn');
    el('saveBtn').disabled = true;
  } else {
    setStatus('', '', true);
    el('saveBtn').disabled = false;
  }
}

function tabProblem(tab) {
  if (!tab) return 'Aktif sekme bulunamadı.';
  const url = String(tab.url || '');
  if (!url) return '';
  if (BLOCKED_SCHEME.test(url)) {
    return 'Tarayıcı iç sayfaları PDF’e kaydedilemez. Normal bir web sayfası açın.';
  }
  if (WEB_STORE.test(url)) {
    return 'Chrome Web Mağazası sayfaları güvenlik nedeniyle kaydedilemez.';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Kaydetme                                                            */
/* ------------------------------------------------------------------ */

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;

  if (!activeTab) {
    activeTab = await getActiveTab();
    renderTab(activeTab);
    applyTabState(activeTab);
  }

  const problem = tabProblem(activeTab);
  if (problem) {
    setStatus(problem, 'warn');
    return;
  }

  busy = true;
  setBusy(true);
  setStatus('Sayfa hazırlanıyor…', 'progress');

  try {
    await persistSettings();

    const response = await chrome.runtime.sendMessage({
      type: 'pagedf:save',
      tabId: activeTab ? activeTab.id : undefined,
      options: readSettings()
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'PDF oluşturulamadı.');
    }

    const size = response.bytes ? ' · ' + formatBytes(response.bytes) : '';
    setStatus('Kaydedildi: ' + response.filename + size, 'success');
  } catch (error) {
    setStatus(friendlyMessage(error), 'error');
  } finally {
    busy = false;
    setBusy(false);
  }
}

function setBusy(state) {
  const button = el('saveBtn');
  const label = el('saveLabel');

  label.textContent = state ? 'PDF oluşturuluyor…' : 'PDF olarak kaydet';
  button.classList.toggle('is-busy', state);
  button.disabled = state || Boolean(tabProblem(activeTab));
}

function onRuntimeMessage(message) {
  if (!message || message.type !== 'pagedf:progress') return false;
  if (!busy) return false;
  setStatus(message.text || 'İşleniyor…', 'progress');
  return false;
}

function setStatus(text, tone, hide) {
  const box = el('status');
  const textEl = el('statusText');

  if (hide || !text) {
    box.hidden = true;
    box.className = 'status';
    textEl.textContent = '';
    return;
  }

  box.hidden = false;
  box.className = 'status' + (tone ? ' is-' + tone : '');
  textEl.textContent = text;
}

function friendlyMessage(error) {
  const message = String((error && error.message) || error || '').trim();

  if (!message) return 'Bilinmeyen bir hata oluştu.';
  if (/receiving end does not exist|could not establish connection/i.test(message)) {
    return 'Arka plan servisine ulaşılamadı. Eklentiyi yeniden yükleyip tekrar deneyin.';
  }
  return message;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const rounded = value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1);
  return rounded + ' ' + units[index];
}
