'use strict';

/*
 * Pagedf — açık sekmeyi Chrome DevTools Protocol üzerinden
 * Page.printToPDF ile yüksek sadakatle PDF'e çevirir.
 *
 * Akış: debugger bağla -> (görselleri hazırla) -> ekran medyası emüle et
 *       -> Page.printToPDF -> bağlantıyı kes -> indirmeyi başlat
 */

const PAPER_SIZES = {
  a4: { width: 8.27, height: 11.69 },
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  a3: { width: 11.69, height: 16.54 },
  a5: { width: 5.83, height: 8.27 },
  tabloid: { width: 11, height: 17 }
};

const MARGIN_SIZES = { none: 0, narrow: 0.3, normal: 0.6, wide: 1 };

const BLOCKED_URL = /^(chrome|brave|edge|devtools|chrome-extension|chrome-search|chrome-untrusted|about|view-source|data|blob|javascript|filesystem):/i;
const WEB_STORE_URL = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const PRINT_TIMEOUT_MS = 120000;
const KEEP_ALIVE_MS = 20000;

const HEADER_TEMPLATE = [
  '<div style="width:100%;padding:0 10mm;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;',
  'font-size:8px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;gap:12px;">',
  '<span class="title" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"></span>',
  '<span class="date" style="white-space:nowrap;"></span>',
  '</div>'
].join('');

const FOOTER_TEMPLATE = [
  '<div style="width:100%;padding:0 10mm;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;',
  'font-size:8px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;gap:12px;">',
  '<span class="url" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"></span>',
  '<span style="white-space:nowrap;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>',
  '</div>'
].join('');

/*
 * Sayfanın tamamını birkaç ekran kaydırarak geç: tembel yüklenen görselleri
 * ve aşağı kaydırınca açılan bölümleri tetikler. Sonunda başlangıç konumuna döner.
 */
const PRELOAD_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const scrollTo = (y) => {
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); }
    catch (e) { window.scrollTo(0, y); }
  };
  const doc = document;
  const startY = window.scrollY || window.pageYOffset || 0;
  const viewport = window.innerHeight || 800;
  const step = Math.max(320, Math.floor(viewport * 0.85));
  let limit = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);

  doc.querySelectorAll('img[loading="lazy"]').forEach((img) => {
    try { img.loading = 'eager'; } catch (e) { /* yoksay */ }
  });

  for (let i = 0, y = 0; i < 60 && y < limit; i += 1) {
    scrollTo(y);
    await sleep(110);
    y += step;
    limit = Math.max(limit, doc.documentElement.scrollHeight);
  }

  scrollTo(0);
  await sleep(120);

  const pending = Array.prototype.filter.call(doc.images, (img) => !img.complete);
  if (pending.length > 0) {
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2500);
      }))),
      sleep(5000)
    ]);
  }

  scrollTo(startY);
  await sleep(150);
  return true;
})()`;

/* ------------------------------------------------------------------ */
/* Mesaj girişi                                                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'pagedf:save') return false;

  savePage(message)
    .then((result) => sendResponse(Object.assign({ ok: true }, result)))
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));

  return true;
});

/* ------------------------------------------------------------------ */
/* Ana akış                                                            */
/* ------------------------------------------------------------------ */

async function savePage(message) {
  const tab = await resolveTab(message);
  assertPrintable(tab);

  const options = normalizeOptions(message.options);
  const tabId = tab.id;

  let attached = false;
  let screenEmulated = false;
  let keepAlive = 0;

  keepAlive = setInterval(() => {
    // MV3 servis çalışanının iş sürerken uyumasını engeller.
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch (_) { /* yoksay */ }
  }, KEEP_ALIVE_MS);

  progress('Sayfa hazırlanıyor…', 5);

  try {
    await attach(tabId);
    attached = true;

    const meta = await readMeta(tabId);
    const title = String(meta.title || tab.title || '').trim();

    if (options.lazyImages) {
      progress('İçerik ve görseller hazırlanıyor…', 20);
      await preloadContent(tabId);
    }

    if (options.screenMedia) {
      await send(tabId, 'Emulation.setEmulatedMedia', { media: 'screen', features: [] });
      screenEmulated = true;
    }

    progress('PDF oluşturuluyor…', 45);

    const result = await withTimeout(
      send(tabId, 'Page.printToPDF', buildPrintParams(options)),
      PRINT_TIMEOUT_MS,
      'PDF oluşturma zaman aşımına uğradı. Sayfa çok büyük veya yanıt vermiyor olabilir.'
    );

    if (!result || typeof result.data !== 'string' || result.data.length === 0) {
      throw new Error('PDF verisi alınamadı.');
    }

    const bytes = Math.max(0, Math.floor(result.data.length * 0.75));
    const filename = buildFilename(title);

    await resetEmulatedMedia(tabId);
    screenEmulated = false;
    await detach(tabId);
    attached = false;

    progress('İndiriliyor…', 92);
    const downloadId = await downloadPdf(result.data, filename, options.saveAs);
    progress('PDF hazır', 100);

    return { filename, bytes, downloadId };
  } finally {
    clearInterval(keepAlive);
    if (screenEmulated) await resetEmulatedMedia(tabId);
    if (attached) await detach(tabId);
  }
}

/* ------------------------------------------------------------------ */
/* Seçenekler                                                          */
/* ------------------------------------------------------------------ */

function normalizeOptions(raw) {
  const options = raw && typeof raw === 'object' ? raw : {};
  const paperKey = Object.prototype.hasOwnProperty.call(PAPER_SIZES, options.paper)
    ? options.paper
    : 'a4';
  const landscape = options.orientation === 'landscape';
  const marginKey = Object.prototype.hasOwnProperty.call(MARGIN_SIZES, options.margin)
    ? options.margin
    : 'normal';

  const paper = PAPER_SIZES[paperKey];
  const margin = MARGIN_SIZES[marginKey];
  const headerFooter = options.headerFooter === true;

  const scaleValue = Number(options.scale);
  const scale = Number.isFinite(scaleValue) ? Math.min(2, Math.max(0.1, scaleValue)) : 1;

  // Üst/alt bilgi görünür olsun diye dikey kenar boşluğu en az 0,45 inç yapılır.
  const verticalMargin = headerFooter ? Math.max(margin, 0.45) : margin;

  return {
    landscape,
    scale,
    printBackground: options.printBackground !== false,
    screenMedia: options.screenMedia !== false,
    lazyImages: options.lazyImages !== false,
    headerFooter,
    saveAs: options.saveAs !== false,
    preferCSSPageSize: options.paper === 'css',
    // Ölçüler her zaman dikey verilir; yatay yönde Chrome sayfayı kendisi döndürür.
    paperWidth: paper.width,
    paperHeight: paper.height,
    marginTop: verticalMargin,
    marginBottom: verticalMargin,
    marginLeft: margin,
    marginRight: margin
  };
}

function buildPrintParams(options) {
  const params = {
    landscape: options.landscape,
    displayHeaderFooter: options.headerFooter,
    printBackground: options.printBackground,
    scale: options.scale,
    paperWidth: options.paperWidth,
    paperHeight: options.paperHeight,
    marginTop: options.marginTop,
    marginBottom: options.marginBottom,
    marginLeft: options.marginLeft,
    marginRight: options.marginRight,
    preferCSSPageSize: options.preferCSSPageSize,
    transferMode: 'ReturnAsBase64'
  };

  if (options.headerFooter) {
    params.headerTemplate = HEADER_TEMPLATE;
    params.footerTemplate = FOOTER_TEMPLATE;
  }

  return params;
}

/* ------------------------------------------------------------------ */
/* Sekme / sayfa hazırlığı                                             */
/* ------------------------------------------------------------------ */

async function resolveTab(message) {
  const tabId = Number(message && message.tabId);
  if (Number.isInteger(tabId) && tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) return tab;
    } catch (_) { /* aktif sekmeye düş */ }
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) throw new Error('Aktif sekme bulunamadı.');
  return tab;
}

function assertPrintable(tab) {
  const url = String(tab.url || '');
  if (!url) return;
  if (BLOCKED_URL.test(url)) {
    throw new Error('Bu sayfa PDF’e kaydedilemez: tarayıcı iç sayfaları ve arayüz sayfaları desteklenmiyor. Normal bir web sayfası açın.');
  }
  if (WEB_STORE_URL.test(url)) {
    throw new Error('Chrome Web Mağazası sayfaları güvenlik nedeniyle PDF’e kaydedilemez.');
  }
}

async function readMeta(tabId) {
  try {
    const result = await send(tabId, 'Runtime.evaluate', {
      expression: '({ title: document.title || "", url: location.href || "" })',
      returnByValue: true
    });
    const value = result && result.result ? result.result.value : null;
    if (value && typeof value === 'object') {
      return { title: value.title, url: value.url };
    }
  } catch (_) { /* başlık sekme bilgisinden alınır */ }
  return {};
}

async function preloadContent(tabId) {
  try {
    await withTimeout(
      send(tabId, 'Runtime.evaluate', {
        expression: PRELOAD_SCRIPT,
        awaitPromise: true,
        returnByValue: true
      }),
      20000,
      'İçerik hazırlığı zaman aşımına uğradı.'
    );
  } catch (_) {
    // Sayfa hazırlanamasa da PDF üretmeye devam et.
  }
}

/* ------------------------------------------------------------------ */
/* CDP yardımcıları                                                    */
/* ------------------------------------------------------------------ */

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function resetEmulatedMedia(tabId) {
  return send(tabId, 'Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {});
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/* ------------------------------------------------------------------ */
/* İndirme                                                             */
/* ------------------------------------------------------------------ */

function downloadPdf(base64, filename, saveAs) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: 'data:application/pdf;base64,' + base64,
        filename,
        saveAs: Boolean(saveAs),
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(downloadId);
      }
    );
  });
}

function buildFilename(title) {
  let base = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');

  if (base.length > 120) base = base.slice(0, 120).trim();
  if (!base) base = 'sayfa';
  if (RESERVED_WINDOWS_NAMES.test(base)) base = '_' + base;

  return base + '.pdf';
}

/* ------------------------------------------------------------------ */
/* İlerleme ve hata mesajları                                          */
/* ------------------------------------------------------------------ */

function progress(text, percent) {
  try {
    const pending = chrome.runtime.sendMessage({
      type: 'pagedf:progress',
      text,
      percent
    });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (_) { /* popup kapalıysa yoksay */ }
}

function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const message = raw.toLowerCase();

  if (!raw) return 'Bilinmeyen bir hata oluştu.';

  if (message.includes('download canceled') || message.includes('canceled by the user') || message.includes('user_canceled')) {
    return 'İndirme iptal edildi.';
  }
  if (message.includes('already attached')) {
    return 'Bu sekmede zaten bir hata ayıklayıcı bağlı. DevTools açıksa kapatın, ardından sayfayı yenileyip tekrar deneyin.';
  }
  if (message.includes('cannot access') || message.includes('cannot attach') || message.includes('not allowed') || message.includes('permission denied')) {
    return 'Bu sayfaya erişilemiyor. Tarayıcı iç sayfaları, Web Mağazası ve korumalı sayfalar PDF’e kaydedilemez.';
  }
  if (message.includes('detached') || message.includes('target closed')) {
    return 'Sekmeyle bağlantı kesildi. Sayfa kapanmış veya yenilenmiş olabilir; tekrar deneyin.';
  }
  if (message.includes('invalid filename')) {
    return 'Dosya adı oluşturulamadı. Lütfen tekrar deneyin.';
  }
  return raw;
}
