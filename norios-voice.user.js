// ==UserScript==
// @name         NoriOS Voice
// @namespace    https://cubesky.github.io/NoriOS-Voice/
// @version      4.2.0
// @description  NoriOS sherpa-onnx voice input, KWS wake word, VAD auto-end and local model cache
// @author       CubeSky
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://cubesky.github.io/NoriOS-Voice/
// @updateURL    https://cubesky.github.io/NoriOS-Voice/norios-voice.user.js
// @downloadURL  https://cubesky.github.io/NoriOS-Voice/norios-voice.user.js
// ==/UserScript==

(() => {
  "use strict";

  const CFG = {
    analysisButton: 'button[aria-label="分析窗口"]',
    input: 'input[maxlength="100"]',

    // Official sherpa-onnx Chinese Zipformer CTC VAD+ASR WebAssembly demo.
    assetBase:
      'https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/main/',

    scripts: [
      'sherpa-onnx-asr.js',
      'sherpa-onnx-vad.js',
      'app-vad-asr.js',
      'sherpa-onnx-wasm-main-vad-asr.js',
    ],

    submitDelayMs: 600,
    initTimeoutMs: 180000,
    recognitionTimeoutMs: 15000,
    recognitionPollMs: 120,
    resultStableMs: 420,

    cacheDbName: 'sherpa-onnx-bookmarklet-cache',
    cacheDbVersion: 1,
    cacheStoreName: 'assets',
    cacheDataFile: 'sherpa-onnx-wasm-main-vad-asr.data',
    cacheVersion: 'zh-zipformer-ctc-2025-07-03-v1',

    // KWS is a separate sherpa-onnx WebAssembly runtime.
    // KWS assets are hosted on NoriOS-Voice GitHub Pages.
    // Optional debug override:
    //   window.SHERPA_KWS_ASSET_BASE = 'https://.../sherpa-kws/';
    kwsAssetBase:
      window.SHERPA_KWS_ASSET_BASE ||
      'https://cubesky.github.io/NoriOS-Voice/sherpa-kws/',

    kwsEnabledStorageKey: 'sherpa-bookmarklet-kws-enabled',
    kwsKeywordLabel: 'NORI',
    // "nori" pronounced as "no-li"
    // sherpa-onnx open-vocabulary KWS keyword format:
    // tokens :boost #threshold @display-name
    kwsKeywordTokens: 'N OW1 L IY1 :1.5 #0.20 @NORI',

    kwsRuntimeScript: 'sherpa-onnx-wasm-kws-main.js',
    kwsWrapperScript: 'sherpa-onnx-kws.js',

    kwsModel: {
      encoder: './encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
      decoder: './decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
      joiner: './joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
      tokens: './tokens.txt',
    },

    wakeCommandTimeoutMs: 10000,

    // After the VAD+ASR demo emits a valid Result:, wait briefly for any
    // final update, then automatically stop the recognition session.
    vadAutoEndSettleMs: 520,
  };

  const KEY = '__NoriOSVoiceRuntime__';

  // Remove a previous v3 instance, if present.
  try {
    window[KEY]?.destroy?.();
  } catch {}

  const state = {
    destroyed: false,
    micButton: null,
    iframe: null,
    iframeWindow: null,
    loadingPromise: null,
    ready: false,
    isHolding: false,
    submitTimer: null,
    submitGeneration: 0,
    lastSubmittedText: '',
    lastSubmittedAt: 0,
    submitDedupWindowMs: 2500,
    observers: [],
    progressOverlay: null,
    progressBar: null,
    progressPercent: null,
    progressStatus: null,
    progressDetail: null,
    progressHideTimer: null,

    menu: null,

    kwsEnabled: false,
    kwsReady: false,
    kwsLoadingPromise: null,
    kwsIframe: null,
    kws: null,
    kwsStream: null,
    kwsMediaStream: null,
    kwsAudioContext: null,
    kwsSource: null,
    kwsProcessor: null,
    kwsBusy: false,

    activeInputFrame: null,
    activeInputFramePrevBorder: null,
    activeInputFramePrevBoxShadow: null,
    activeInputFramePrevTransition: null,
  };

  window[KEY] = state;

  const log = (...args) => console.log('[norios-voice 4.2]', ...args);
  const warn = (...args) => console.warn('[norios-voice 4.2]', ...args);

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function createProgressOverlay() {
    document.getElementById('__sherpa_norios_progress__')?.remove();
    document.getElementById('__sherpa_norios_progress_style__')?.remove();

    const root = document.createElement('div');
    root.id = '__sherpa_norios_progress__';
    root.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:50%',
      'transform:translate(-50%,-50%) scale(.96)',
      'width:min(520px,calc(100vw - 48px))',
      'z-index:2147483647',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .22s ease,transform .22s ease',
      'font-family:Inter,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'color:#c6f8ff',
    ].join(';');

    root.innerHTML = `
      <div class="sherpa-norios-frame">
        <div class="sherpa-norios-corner c1"></div>
        <div class="sherpa-norios-corner c2"></div>
        <div class="sherpa-norios-corner c3"></div>
        <div class="sherpa-norios-corner c4"></div>
        <div class="sherpa-norios-scan"></div>

        <div class="sherpa-norios-head">
          <span class="sherpa-norios-chip">VOICE</span>
          <span class="sherpa-norios-title">语音识别模块初始化</span>
          <span class="sherpa-norios-state">LOCAL // WASM</span>
        </div>

        <div class="sherpa-norios-divider"></div>

        <div class="sherpa-norios-main">
          <div class="sherpa-norios-glyph">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <path d="M12 19v3"></path>
            </svg>
          </div>

          <div class="sherpa-norios-info">
            <div class="sherpa-norios-row">
              <span id="__sherpa_norios_status__">准备运行环境</span>
              <span id="__sherpa_norios_percent__">0%</span>
            </div>

            <div class="sherpa-norios-progress-track">
              <div id="__sherpa_norios_progress_bar__"></div>
              <div class="sherpa-norios-progress-shimmer"></div>
            </div>

            <div id="__sherpa_norios_detail__" class="sherpa-norios-detail">
              正在建立隔离运行环境…
            </div>
          </div>
        </div>

        <div class="sherpa-norios-foot">
          <span>SHERPA-ONNX</span>
          <span class="sherpa-norios-pulse"><i></i> OFFLINE SPEECH ENGINE</span>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.id = '__sherpa_norios_progress_style__';
    style.textContent = `
      #__sherpa_norios_progress__ .sherpa-norios-frame{
        position:relative;overflow:hidden;padding:15px 18px 13px;
        background:linear-gradient(180deg,rgba(16,34,48,.985),rgba(5,24,34,.985));
        border:1px solid rgba(119,241,255,.82);
        box-shadow:0 0 0 1px rgba(64,181,199,.28) inset,0 0 18px rgba(69,220,241,.18),0 18px 55px rgba(0,0,0,.5);
        clip-path:polygon(10px 0,calc(100% - 10px) 0,100% 10px,100% calc(100% - 10px),calc(100% - 10px) 100%,10px 100%,0 calc(100% - 10px),0 10px);
      }
      #__sherpa_norios_progress__ .sherpa-norios-frame:before{
        content:"";position:absolute;inset:0;pointer-events:none;
        background:linear-gradient(90deg,transparent 0 14%,rgba(96,226,242,.025) 14% 14.3%,transparent 14.3% 62%,rgba(96,226,242,.025) 62% 62.25%,transparent 62.25%),
        repeating-linear-gradient(0deg,rgba(162,249,255,.026) 0 1px,transparent 1px 4px);
        mix-blend-mode:screen;
      }
      #__sherpa_norios_progress__ .sherpa-norios-scan{
        position:absolute;left:0;right:0;top:-35%;height:34%;pointer-events:none;
        background:linear-gradient(180deg,transparent,rgba(128,244,255,.055),transparent);
        animation:sherpaNoriScan 2.8s linear infinite;
      }
      @keyframes sherpaNoriScan{from{transform:translateY(0)}to{transform:translateY(440%)}}
      #__sherpa_norios_progress__ .sherpa-norios-head{position:relative;display:flex;align-items:center;gap:10px;min-height:24px;letter-spacing:.08em}
      #__sherpa_norios_progress__ .sherpa-norios-chip{padding:2px 7px;border:1px solid rgba(105,233,249,.66);background:rgba(75,212,229,.1);color:#8beef8;font-size:10px;line-height:15px;box-shadow:0 0 9px rgba(68,225,246,.11) inset}
      #__sherpa_norios_progress__ .sherpa-norios-title{font-size:14px;font-weight:650;color:#d7faff;text-shadow:0 0 10px rgba(126,239,255,.2)}
      #__sherpa_norios_progress__ .sherpa-norios-state{margin-left:auto;font:10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(149,224,233,.53)}
      #__sherpa_norios_progress__ .sherpa-norios-divider{position:relative;height:1px;margin:9px 0 13px;background:linear-gradient(90deg,rgba(109,237,250,.8),rgba(109,237,250,.16) 70%,transparent);box-shadow:0 0 7px rgba(71,223,240,.32)}
      #__sherpa_norios_progress__ .sherpa-norios-main{position:relative;display:flex;align-items:center;gap:15px}
      #__sherpa_norios_progress__ .sherpa-norios-glyph{width:58px;height:58px;flex:none;display:grid;place-items:center;border:1px solid rgba(110,236,250,.6);background:radial-gradient(circle at 50% 50%,rgba(84,225,242,.18),rgba(23,73,86,.12) 58%,rgba(5,20,28,.4));box-shadow:0 0 13px rgba(76,225,244,.15),0 0 10px rgba(84,229,246,.13) inset;transform:rotate(45deg)}
      #__sherpa_norios_progress__ .sherpa-norios-glyph svg{width:27px;height:27px;transform:rotate(-45deg);fill:none;stroke:#9bf4ff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 5px rgba(92,233,248,.55))}
      #__sherpa_norios_progress__ .sherpa-norios-info{min-width:0;flex:1}
      #__sherpa_norios_progress__ .sherpa-norios-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:7px}
      #__sherpa_norios_status__{font-size:13px;color:#c7f5fa}
      #__sherpa_norios_percent__{font:700 19px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:#9cf4ff;text-shadow:0 0 9px rgba(83,234,249,.35)}
      #__sherpa_norios_progress__ .sherpa-norios-progress-track{position:relative;overflow:hidden;height:10px;border:1px solid rgba(103,223,237,.42);background:rgba(0,10,17,.66);box-shadow:0 0 7px rgba(61,216,234,.08) inset}
      #__sherpa_norios_progress_bar__{position:absolute;inset:1px auto 1px 1px;width:0%;background:linear-gradient(90deg,rgba(72,183,201,.64),rgba(119,239,250,.92));box-shadow:0 0 7px rgba(89,236,250,.52),0 0 10px rgba(89,236,250,.25) inset;transition:width .18s ease}
      #__sherpa_norios_progress__ .sherpa-norios-progress-shimmer{position:absolute;inset:0;background:linear-gradient(105deg,transparent 0 36%,rgba(211,253,255,.14) 48%,transparent 60%);transform:translateX(-110%);animation:sherpaNoriShimmer 1.45s ease-in-out infinite}
      @keyframes sherpaNoriShimmer{to{transform:translateX(110%)}}
      #__sherpa_norios_progress__ .sherpa-norios-detail{margin-top:7px;min-height:14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(158,226,233,.57)}
      #__sherpa_norios_progress__ .sherpa-norios-foot{position:relative;display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:8px;border-top:1px solid rgba(87,189,201,.15);font:9px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.09em;color:rgba(145,218,226,.39)}
      #__sherpa_norios_progress__ .sherpa-norios-pulse i{display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#7df4ff;box-shadow:0 0 7px rgba(110,241,255,.8);animation:sherpaNoriPulse 1.15s ease-in-out infinite}
      @keyframes sherpaNoriPulse{50%{opacity:.25;box-shadow:0 0 2px rgba(110,241,255,.2)}}
      #__sherpa_norios_progress__ .sherpa-norios-corner{position:absolute;width:8px;height:8px;z-index:3;pointer-events:none}
      #__sherpa_norios_progress__ .c1{left:5px;top:5px;border-left:1px solid #a1f7ff;border-top:1px solid #a1f7ff}
      #__sherpa_norios_progress__ .c2{right:5px;top:5px;border-right:1px solid #a1f7ff;border-top:1px solid #a1f7ff}
      #__sherpa_norios_progress__ .c3{left:5px;bottom:5px;border-left:1px solid #a1f7ff;border-bottom:1px solid #a1f7ff}
      #__sherpa_norios_progress__ .c4{right:5px;bottom:5px;border-right:1px solid #a1f7ff;border-bottom:1px solid #a1f7ff}
      #__sherpa_norios_progress__.is-error .sherpa-norios-frame{border-color:rgba(255,178,91,.82);box-shadow:0 0 18px rgba(255,150,66,.13),0 18px 55px rgba(0,0,0,.5)}
      #__sherpa_norios_progress__.is-error #__sherpa_norios_percent__,
      #__sherpa_norios_progress__.is-error #__sherpa_norios_status__{color:#ffd09c}
    `;

    document.head.appendChild(style);
    document.documentElement.appendChild(root);

    state.progressOverlay = root;
    state.progressBar = root.querySelector('#__sherpa_norios_progress_bar__');
    state.progressPercent = root.querySelector('#__sherpa_norios_percent__');
    state.progressStatus = root.querySelector('#__sherpa_norios_status__');
    state.progressDetail = root.querySelector('#__sherpa_norios_detail__');

    return root;
  }

  function updateProgress(percent, status, detail = '') {
    if (!state.progressOverlay?.isConnected) createProgressOverlay();

    clearTimeout(state.progressHideTimer);

    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    state.progressBar.style.width = `${p}%`;
    state.progressPercent.textContent = `${Math.round(p)}%`;

    if (status) state.progressStatus.textContent = status;
    if (detail) state.progressDetail.textContent = detail;

    state.progressOverlay.classList.remove('is-error');
    state.progressOverlay.style.display = '';

    requestAnimationFrame(() => {
      state.progressOverlay.style.opacity = '1';
      state.progressOverlay.style.transform = 'translate(-50%,-50%) scale(1)';
    });
  }

  function finishProgress() {
    updateProgress(100, '语音识别模块就绪', '本地模型初始化完成');
    state.progressHideTimer = setTimeout(() => {
      if (!state.progressOverlay) return;
      state.progressOverlay.style.opacity = '0';
      state.progressOverlay.style.transform = 'translate(-50%,-50%) scale(.985)';
      setTimeout(() => {
        if (state.progressOverlay) state.progressOverlay.style.display = 'none';
      }, 260);
    }, 650);
  }

  function failProgress(message) {
    if (!state.progressOverlay?.isConnected) createProgressOverlay();
    state.progressOverlay.classList.add('is-error');
    state.progressStatus.textContent = '语音模块初始化失败';
    state.progressDetail.textContent = String(message || 'Unknown error');
    state.progressPercent.textContent = 'ERR';
    state.progressOverlay.style.display = '';
    state.progressOverlay.style.opacity = '1';
    state.progressOverlay.style.transform = 'translate(-50%,-50%) scale(1)';
  }

  function micSvg() {
    return `
      <span class="flex"
            style="color: rgba(210, 232, 233, 0.565);
                   filter: drop-shadow(rgba(78, 224, 200, 0) 0px 0px 0px);
                   transform: none;">
        <svg xmlns="http://www.w3.org/2000/svg"
             width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" style="color: inherit; opacity: 1;">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" x2="12" y1="19" y2="22"></line>
        </svg>
      </span>`;
  }

  function buildMicButton(reference) {
    // DO NOT clone the React-controlled button.
    // Only copy presentation-related serialised properties.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', '按住语音输入');
    btn.setAttribute('tabindex', '0');
    btn.dataset.sherpaMicButtonV3 = '1';

    btn.className = reference.className;
    btn.style.cssText = reference.style.cssText;
    btn.innerHTML = micSvg();

    // Suppress an ordinary click entirely.
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);

    return btn;
  }

  function refreshAppearance() {
    if (!state.micButton || state.isHolding) return;

    const ref = document.querySelector(CFG.analysisButton);
    if (!ref) return;

    state.micButton.className = ref.className;
    state.micButton.style.cssText = ref.style.cssText;

    const span = state.micButton.querySelector('span');
    if (span) {
      span.style.color = 'rgba(210, 232, 233, 0.565)';
      span.style.filter =
        'drop-shadow(rgba(78, 224, 200, 0) 0px 0px 0px)';
    }
  }

  function setButtonState(mode) {
    const btn = state.micButton;
    if (!btn) return;

    refreshAppearance();
    const span = btn.querySelector('span');

    btn.dataset.sherpaState = mode;

    switch (mode) {
      case 'recording':
        btn.style.transform = 'scale(0.92)';
        btn.style.opacity = '1';
        if (span) span.style.color = 'rgb(239, 68, 68)';
        btn.title = '正在录音，松开后识别';
        break;

      case 'loading':
        btn.style.opacity = '0.55';
        btn.title = '正在加载 sherpa-onnx 中文模型…';
        break;

      case 'recognizing':
        btn.style.opacity = '0.75';
        if (span) span.style.color = 'rgb(96, 165, 250)';
        btn.title = '正在识别…';
        break;

      case 'error':
        btn.style.opacity = '0.7';
        if (span) span.style.color = 'rgb(245, 158, 11)';
        btn.title = 'sherpa-onnx 出错；刷新页面后可重新运行书签';
        break;

      default:
        btn.title = '按住说话，松开识别并提交';
        break;
    }
  }


  function openModelCacheDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }

      const req = indexedDB.open(CFG.cacheDbName, CFG.cacheDbVersion);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CFG.cacheStoreName)) {
          db.createObjectStore(CFG.cacheStoreName, { keyPath: 'key' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
    });
  }

  async function readCachedModelBlob() {
    let db;
    try {
      db = await openModelCacheDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(CFG.cacheStoreName, 'readonly');
        const req = tx.objectStore(CFG.cacheStoreName).get(CFG.cacheVersion);

        req.onsuccess = () => {
          const rec = req.result;
          resolve(
            rec &&
            rec.version === CFG.cacheVersion &&
            rec.blob instanceof Blob &&
            rec.blob.size > 0
              ? rec.blob
              : null
          );
        };

        req.onerror = () =>
          reject(req.error || new Error('读取模型缓存失败'));
      });
    } finally {
      try { db?.close(); } catch {}
    }
  }

  async function writeCachedModelBlob(blob) {
    let db;
    try {
      db = await openModelCacheDb();

      await new Promise((resolve, reject) => {
        const tx = db.transaction(CFG.cacheStoreName, 'readwrite');

        tx.objectStore(CFG.cacheStoreName).put({
          key: CFG.cacheVersion,
          version: CFG.cacheVersion,
          filename: CFG.cacheDataFile,
          size: blob.size,
          blob,
          cachedAt: Date.now(),
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error || new Error('写入模型缓存失败'));
        tx.onabort = () =>
          reject(tx.error || new Error('模型缓存事务中止'));
      });
    } finally {
      try { db?.close(); } catch {}
    }
  }

  async function downloadModelBlobWithProgress(url) {
    updateProgress(22, '正在下载中文语音模型', '正在建立模型数据连接…');

    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    });

    if (!response.ok) {
      throw new Error(
        `模型下载失败: HTTP ${response.status} ${response.statusText}`
      );
    }

    const total = Number(response.headers.get('content-length')) || 0;

    if (!response.body?.getReader) {
      const blob = await response.blob();
      updateProgress(
        89,
        '模型下载完成',
        `${(blob.size / 1024 / 1024).toFixed(1)} MiB`
      );
      return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      loaded += value.byteLength;

      if (total > 0) {
        updateProgress(
          22 + (loaded / total) * 66,
          '正在下载中文语音模型',
          `${(loaded / 1024 / 1024).toFixed(1)} MiB / ` +
          `${(total / 1024 / 1024).toFixed(1)} MiB`
        );
      } else {
        updateProgress(
          55,
          '正在下载中文语音模型',
          `已接收 ${(loaded / 1024 / 1024).toFixed(1)} MiB`
        );
      }
    }

    const blob = new Blob(chunks, {
      type:
        response.headers.get('content-type') ||
        'application/octet-stream',
    });

    updateProgress(
      89,
      '模型下载完成',
      `${(blob.size / 1024 / 1024).toFixed(1)} MiB`
    );

    return blob;
  }

  async function prepareCachedModelBlob() {
    updateProgress(7, '检查本地模型缓存', '正在查询 IndexedDB…');

    try {
      const cached = await readCachedModelBlob();

      if (cached) {
        updateProgress(
          84,
          '已命中本地模型缓存',
          `${(cached.size / 1024 / 1024).toFixed(1)} MiB // IndexedDB`
        );
        log('model cache hit:', cached.size);
        return { blob: cached, fromCache: true };
      }
    } catch (err) {
      warn('IndexedDB read failed; fallback to network:', err);
    }

    updateProgress(18, '本地没有模型缓存', '首次运行需要下载模型…');

    const blob = await downloadModelBlobWithProgress(
      CFG.assetBase + CFG.cacheDataFile
    );

    try {
      updateProgress(90, '正在写入本地模型缓存', '正在保存到 IndexedDB…');
      await writeCachedModelBlob(blob);

      updateProgress(
        92,
        '模型缓存已保存',
        `${(blob.size / 1024 / 1024).toFixed(1)} MiB // IndexedDB`
      );
    } catch (err) {
      warn('IndexedDB write failed; continue without persistence:', err);
      updateProgress(
        92,
        '模型已下载',
        'IndexedDB 写入失败，本次继续运行'
      );
    }

    return { blob, fromCache: false };
  }

  function installCachedDataXhr(win, modelBlob) {
    const NativeXHR = win.XMLHttpRequest;
    if (!NativeXHR || NativeXHR.__sherpaCachedDataWrapper) return;

    class SherpaCachedXHR {
      constructor() {
        this._native = null;
        this._listeners = new Map();
        this._url = '';
        this._responseType = '';
        this._useCachedModel = false;

        this.readyState = 0;
        this.status = 0;
        this.statusText = '';
        this.response = null;
        this.responseText = '';
        this.responseURL = '';

        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.onprogress = null;
        this.onloadend = null;
        this.onloadstart = null;
        this.ontimeout = null;
        this.onabort = null;
      }

      get responseType() {
        return this._native ? this._native.responseType : this._responseType;
      }

      set responseType(v) {
        this._responseType = v;
        if (this._native) this._native.responseType = v;
      }

      get timeout() {
        return this._native?.timeout || 0;
      }

      set timeout(v) {
        if (this._native) this._native.timeout = v;
      }

      get withCredentials() {
        return this._native?.withCredentials || false;
      }

      set withCredentials(v) {
        if (this._native) this._native.withCredentials = v;
      }

      addEventListener(type, listener) {
        if (!this._listeners.has(type)) {
          this._listeners.set(type, new Set());
        }

        this._listeners.get(type).add(listener);

        if (this._native) {
          this._native.addEventListener(type, listener);
        }
      }

      removeEventListener(type, listener) {
        this._listeners.get(type)?.delete(listener);
        this._native?.removeEventListener(type, listener);
      }

      _emit(type, event = null) {
        const ev =
          event ||
          new win.ProgressEvent(type, {
            lengthComputable: false,
          });

        const handler = this['on' + type];

        if (typeof handler === 'function') {
          try { handler.call(this, ev); } catch (err) { console.error(err); }
        }

        for (const listener of this._listeners.get(type) || []) {
          try { listener.call(this, ev); } catch (err) { console.error(err); }
        }
      }

      open(method, url, async = true, user, password) {
        this._url = String(url || '');

        this._useCachedModel =
          this._url.includes(CFG.cacheDataFile) ||
          this._url.endsWith('.data');

        if (this._useCachedModel) {
          this.readyState = 1;
          this.responseURL = this._url;
          this._emit('readystatechange');
          return;
        }

        const native = new NativeXHR();
        this._native = native;

        for (const type of [
          'readystatechange',
          'load',
          'error',
          'progress',
          'loadend',
          'loadstart',
          'timeout',
          'abort',
        ]) {
          native.addEventListener(type, ev => {
            this.readyState = native.readyState;
            this.status = native.status;
            this.statusText = native.statusText;
            this.response = native.response;
            try { this.responseText = native.responseText; } catch {}
            this.responseURL = native.responseURL;
            this._emit(type, ev);
          });
        }

        native.open(method, url, async, user, password);

        if (this._responseType) {
          native.responseType = this._responseType;
        }
      }

      setRequestHeader(name, value) {
        this._native?.setRequestHeader(name, value);
      }

      getResponseHeader(name) {
        if (this._native) {
          return this._native.getResponseHeader(name);
        }

        if (this._useCachedModel) {
          const key = String(name).toLowerCase();

          if (key === 'content-length') {
            return String(modelBlob.size);
          }

          if (key === 'content-type') {
            return modelBlob.type || 'application/octet-stream';
          }
        }

        return null;
      }

      getAllResponseHeaders() {
        if (this._native) {
          return this._native.getAllResponseHeaders();
        }

        if (this._useCachedModel) {
          return (
            `content-length: ${modelBlob.size}\r\n` +
            `content-type: ${modelBlob.type || 'application/octet-stream'}\r\n`
          );
        }

        return '';
      }

      overrideMimeType(type) {
        this._native?.overrideMimeType(type);
      }

      abort() {
        if (this._native) {
          this._native.abort();
          return;
        }

        this.readyState = 0;
        this._emit('abort');
        this._emit('loadend');
      }

      async send(body = null) {
        if (this._native) {
          this._native.send(body);
          return;
        }

        if (!this._useCachedModel) {
          throw new Error('XHR internal state invalid');
        }

        this._emit('loadstart');

        try {
          await Promise.resolve();
          const buffer = await modelBlob.arrayBuffer();

          this.readyState = 2;
          this.status = 200;
          this.statusText = 'OK (IndexedDB Cache)';
          this._emit('readystatechange');

          this.readyState = 3;
          this._emit('readystatechange');

          this._emit(
            'progress',
            new win.ProgressEvent('progress', {
              lengthComputable: true,
              loaded: buffer.byteLength,
              total: buffer.byteLength,
            })
          );

          if (this._responseType === 'blob') {
            this.response = modelBlob;
          } else if (
            !this._responseType ||
            this._responseType === 'text'
          ) {
            this.responseText = await modelBlob.text();
            this.response = this.responseText;
          } else {
            this.response = buffer;
          }

          this.readyState = 4;
          this._emit('readystatechange');
          this._emit('load');
          this._emit('loadend');

          updateProgress(
            93,
            '模型已从缓存恢复',
            '正在挂载模型文件到 WASM 虚拟文件系统…'
          );
        } catch (err) {
          this.status = 0;
          this.statusText = String(err?.message || err);
          this.readyState = 4;
          this._emit('readystatechange');
          this._emit('error');
          this._emit('loadend');
        }
      }
    }

    for (const [name, value] of Object.entries({
      UNSENT: 0,
      OPENED: 1,
      HEADERS_RECEIVED: 2,
      LOADING: 3,
      DONE: 4,
    })) {
      SherpaCachedXHR[name] = value;
      SherpaCachedXHR.prototype[name] = value;
    }

    SherpaCachedXHR.__sherpaCachedDataWrapper = true;
    win.XMLHttpRequest = SherpaCachedXHR;
  }


  function loadKwsEnabledPreference() {
    try {
      return localStorage.getItem(CFG.kwsEnabledStorageKey) === '1';
    } catch {
      return false;
    }
  }

  function saveKwsEnabledPreference(enabled) {
    try {
      localStorage.setItem(CFG.kwsEnabledStorageKey, enabled ? '1' : '0');
    } catch {}
  }


  function configureProgressOverlayForKws() {
    if (!state.progressOverlay?.isConnected) {
      createProgressOverlay();
    }

    const title =
      state.progressOverlay.querySelector('.sherpa-norios-title');
    const chip =
      state.progressOverlay.querySelector('.sherpa-norios-chip');
    const runtimeState =
      state.progressOverlay.querySelector('.sherpa-norios-state');

    if (title) title.textContent = '语音唤醒模块初始化';
    if (chip) chip.textContent = 'WAKE';
    if (runtimeState) runtimeState.textContent = 'KWS // WASM';
  }

  function showKwsProgress(percent, status, detail = '') {
    configureProgressOverlayForKws();
    updateProgress(percent, status, detail);
  }

  function finishKwsProgress() {
    configureProgressOverlayForKws();
    updateProgress(100, '语音唤醒模块就绪', 'Nori 唤醒检测已启动');

    state.progressHideTimer = setTimeout(() => {
      if (!state.progressOverlay) return;

      state.progressOverlay.style.opacity = '0';
      state.progressOverlay.style.transform =
        'translate(-50%,-50%) scale(.985)';

      setTimeout(() => {
        if (state.progressOverlay) {
          state.progressOverlay.style.display = 'none';
        }
      }, 260);
    }, 650);
  }

  function failKwsProgress(message) {
    configureProgressOverlayForKws();

    if (!state.progressOverlay?.isConnected) {
      createProgressOverlay();
      configureProgressOverlayForKws();
    }

    state.progressOverlay.classList.add('is-error');
    state.progressStatus.textContent = '语音唤醒模块初始化失败';
    state.progressDetail.textContent =
      String(message || 'Unknown KWS error');
    state.progressPercent.textContent = 'ERR';
    state.progressOverlay.style.display = '';
    state.progressOverlay.style.opacity = '1';
    state.progressOverlay.style.transform =
      'translate(-50%,-50%) scale(1)';
  }

  function createVoiceMenu() {
    state.menu?.remove();

    const menu = document.createElement('div');
    menu.id = '__sherpa_voice_menu__';
    menu.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'min-width:218px',
      'padding:6px',
      'display:none',
      'background:linear-gradient(180deg,rgba(16,35,48,.99),rgba(5,23,33,.99))',
      'border:1px solid rgba(114,235,248,.7)',
      'box-shadow:0 0 0 1px rgba(68,181,199,.18) inset,0 10px 28px rgba(0,0,0,.46),0 0 14px rgba(74,220,240,.12)',
      'clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)',
      'font-family:Inter,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'color:#d2f7fb',
    ].join(';');

    menu.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        padding:4px 7px 6px;
        border-bottom:1px solid rgba(95,213,226,.16);
        color:rgba(163,231,238,.52);
        font:9px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;
        letter-spacing:.08em;">
        <span>VOICE INPUT</span>
        <span>KWS // LOCAL</span>
      </div>

      <div data-kws-toggle-row="1" style="
        margin-top:5px;
        display:flex;align-items:center;gap:10px;
        padding:9px 8px;
        cursor:pointer;
        user-select:none;
        background:rgba(65,190,205,.035);">
        <div style="min-width:0;flex:1;">
          <div style="font-size:12px;color:#d8f9fc;">启用语音唤醒</div>
          <div data-kws-subtitle="1" style="
            margin-top:3px;
            font:9px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;
            color:rgba(151,221,229,.48);">
            唤醒词：Nori
          </div>
        </div>

        <div data-kws-switch="1" style="
          position:relative;
          width:30px;height:15px;
          flex:none;
          border:1px solid rgba(107,220,233,.42);
          background:rgba(3,17,25,.75);
          box-shadow:0 0 6px rgba(70,219,237,.07) inset;">
          <i style="
            position:absolute;left:2px;top:2px;
            width:9px;height:9px;
            background:rgba(132,206,215,.58);
            box-shadow:0 0 4px rgba(98,231,246,.16);
            transition:left .16s ease,background .16s ease,box-shadow .16s ease;"></i>
        </div>
      </div>

      <div data-kws-status="1" style="
        padding:6px 8px 3px;
        font:9px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;
        color:rgba(145,215,223,.42);">
        OFFLINE
      </div>
    `;

    document.documentElement.appendChild(menu);
    state.menu = menu;

    const row = menu.querySelector('[data-kws-toggle-row="1"]');
    row.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    row.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();

      const next = !state.kwsEnabled;
      await setKwsEnabled(next);
      renderKwsMenuState();
    });

    return menu;
  }

  function renderKwsMenuState(detail = '') {
    if (!state.menu?.isConnected) return;

    const sw = state.menu.querySelector('[data-kws-switch="1"]');
    const knob = sw?.querySelector('i');
    const status = state.menu.querySelector('[data-kws-status="1"]');
    const subtitle = state.menu.querySelector('[data-kws-subtitle="1"]');

    if (state.kwsEnabled) {
      if (sw) {
        sw.style.borderColor = 'rgba(112,239,251,.78)';
        sw.style.background = 'rgba(53,176,191,.18)';
      }
      if (knob) {
        knob.style.left = '17px';
        knob.style.background = '#8cf4ff';
        knob.style.boxShadow = '0 0 7px rgba(105,239,252,.62)';
      }
      if (status) {
        status.textContent =
          detail ||
          (state.kwsReady ? 'LISTENING // NORI' : 'INITIALIZING KWS…');
        status.style.color =
          state.kwsReady
            ? 'rgba(137,242,251,.72)'
            : 'rgba(244,204,111,.7)';
      }
      if (subtitle) {
        subtitle.textContent = '唤醒词：Nori';
      }
    } else {
      if (sw) {
        sw.style.borderColor = 'rgba(107,220,233,.42)';
        sw.style.background = 'rgba(3,17,25,.75)';
      }
      if (knob) {
        knob.style.left = '2px';
        knob.style.background = 'rgba(132,206,215,.58)';
        knob.style.boxShadow = '0 0 4px rgba(98,231,246,.16)';
      }
      if (status) {
        status.textContent = detail || 'OFFLINE';
        status.style.color = 'rgba(145,215,223,.42)';
      }
    }
  }

  function positionVoiceMenu(clientX = null, clientY = null) {
    if (!state.menu) return;

    const menuWidth = 218;
    const menuHeight = 128;

    let left;
    let top;

    if (
      Number.isFinite(clientX) &&
      Number.isFinite(clientY)
    ) {
      // Context-menu mode: open near the mouse cursor.
      left = clientX + 5;
      top = clientY + 5;
    } else if (state.micButton) {
      // Fallback for programmatic opening.
      const r = state.micButton.getBoundingClientRect();
      left = r.right - menuWidth;
      top = r.bottom + 7;
    } else {
      left = Math.max(8, (innerWidth - menuWidth) / 2);
      top = Math.max(8, (innerHeight - menuHeight) / 2);
    }

    if (left < 8) left = 8;
    if (left + menuWidth > innerWidth - 8) {
      left = innerWidth - menuWidth - 8;
    }

    if (top < 8) top = 8;
    if (top + menuHeight > innerHeight - 8) {
      top = Math.max(8, top - menuHeight - 10);
    }

    state.menu.style.left = `${left}px`;
    state.menu.style.top = `${top}px`;
  }

  function toggleVoiceMenu(force) {
    if (!state.menu?.isConnected) createVoiceMenu();

    const shouldOpen =
      force !== undefined
        ? !!force
        : state.menu.style.display === 'none';

    if (!shouldOpen) {
      state.menu.style.display = 'none';
      return;
    }

    positionVoiceMenu();
    renderKwsMenuState();
    state.menu.style.display = 'block';
  }

  function attachContextMenu(btn) {
    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (!state.menu?.isConnected) {
        createVoiceMenu();
      }

      renderKwsMenuState();
      positionVoiceMenu(e.clientX, e.clientY);
      state.menu.style.display = 'block';
    }, true);
  }


  async function inspectKwsAsset(url, kind) {
    let response;

    try {
      response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-cache',
      });
    } catch (err) {
      throw new Error(
        `KWS 资源无法访问: ${url}\n${err?.message || err}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `KWS 资源 HTTP ${response.status}: ${url}`
      );
    }

    const contentType =
      (response.headers.get('content-type') || '').toLowerCase();

    // For JS resources, read a small text body and detect SPA/index.html fallbacks.
    if (kind === 'js') {
      const text = await response.text();
      const trimmed = text.trimStart();

      if (
        contentType.includes('text/html') ||
        trimmed.startsWith('<!DOCTYPE') ||
        trimmed.startsWith('<html') ||
        trimmed.startsWith('<')
      ) {
        throw new Error(
          'KWS 资产未部署：请求 JS 时服务器返回了 HTML。\n' +
          `URL: ${url}\n` +
          '目标站点很可能把不存在的 /sherpa-kws/* 路径回退到了 SPA index.html。'
        );
      }

      return {
        url,
        ok: true,
        contentType,
        size: text.length,
      };
    }

    if (kind === 'wasm') {
      const buf = await response.arrayBuffer();
      const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8));

      // WebAssembly magic: 00 61 73 6d
      if (
        u8.length < 4 ||
        u8[0] !== 0x00 ||
        u8[1] !== 0x61 ||
        u8[2] !== 0x73 ||
        u8[3] !== 0x6d
      ) {
        throw new Error(
          'KWS WASM 资源内容无效（不是 WebAssembly 二进制）。\n' +
          `URL: ${url}\n` +
          `Content-Type: ${contentType || '(none)'}`
        );
      }

      return {
        url,
        ok: true,
        contentType,
        size: buf.byteLength,
      };
    }

    // .data can be arbitrary binary; reject obvious HTML fallback.
    if (kind === 'data') {
      const blob = await response.blob();

      if (contentType.includes('text/html')) {
        throw new Error(
          'KWS DATA 资源返回 HTML，而不是模型数据。\n' +
          `URL: ${url}`
        );
      }

      return {
        url,
        ok: true,
        contentType,
        size: blob.size,
      };
    }

    return { url, ok: true, contentType };
  }

  async function preflightKwsAssets() {
    const base = CFG.kwsAssetBase;

    const assets = [
      {
        name: CFG.kwsWrapperScript,
        kind: 'js',
        url: base + CFG.kwsWrapperScript,
      },
      {
        name: CFG.kwsRuntimeScript,
        kind: 'js',
        url: base + CFG.kwsRuntimeScript,
      },
      {
        name: 'sherpa-onnx-wasm-kws-main.wasm',
        kind: 'wasm',
        url: base + 'sherpa-onnx-wasm-kws-main.wasm',
      },
      {
        name: 'sherpa-onnx-wasm-kws-main.data',
        kind: 'data',
        url: base + 'sherpa-onnx-wasm-kws-main.data',
      },
    ];

    renderKwsMenuState('CHECKING KWS ASSETS…');
    showKwsProgress(5, '检查 KWS 运行资源', '正在验证 JavaScript / WASM / DATA…');

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];

      showKwsProgress(
        7 + i * 5,
        '检查 KWS 运行资源',
        `正在验证 ${asset.name}`
      );
      try {
        const info = await inspectKwsAsset(asset.url, asset.kind);
        log(
          'KWS asset OK:',
          asset.name,
          info.contentType || '',
          info.size || ''
        );
      } catch (err) {
        warn('KWS asset preflight failed:', asset.name, err);

        const menuStatus =
          state.menu?.querySelector('[data-kws-status="1"]');

        if (menuStatus) {
          menuStatus.textContent = 'KWS ASSETS MISSING';
          menuStatus.style.color = 'rgba(255,174,112,.9)';
        }

        throw err;
      }
    }
  }

  async function loadScriptIntoKwsFrame(doc, url) {
    // Fetch first so a SPA HTML fallback cannot become a misleading SyntaxError.
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    });

    if (!response.ok) {
      throw new Error(`KWS 脚本 HTTP ${response.status}: ${url}`);
    }

    const text = await response.text();
    const trimmed = text.trimStart();

    if (
      (response.headers.get('content-type') || '')
        .toLowerCase()
        .includes('text/html') ||
      trimmed.startsWith('<')
    ) {
      throw new Error(
        'KWS 脚本 URL 返回了 HTML，而不是 JavaScript: ' + url
      );
    }

    // Execute the verified JS inside the isolated iframe.
    const blob = new Blob([text], {
      type: 'text/javascript',
    });
    const blobUrl = URL.createObjectURL(blob);

    try {
      await new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = blobUrl;
        s.async = false;
        s.onload = resolve;
        s.onerror = () =>
          reject(new Error(`KWS 脚本执行失败: ${url}`));
        doc.head.appendChild(s);
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function ensureKwsLoaded() {
    if (state.kwsReady) return;
    if (state.kwsLoadingPromise) return state.kwsLoadingPromise;

    state.kwsLoadingPromise = (async () => {
      configureProgressOverlayForKws();
      showKwsProgress(3, '准备语音唤醒模块', '正在初始化 KWS…');
      renderKwsMenuState('CHECKING KWS ASSETS…');

      await preflightKwsAssets();

      showKwsProgress(30, '建立 KWS 隔离环境', '正在创建独立 WASM 运行容器…');
      renderKwsMenuState('LOADING KWS RUNTIME…');

      const old = document.getElementById('__sherpa_kws_frame__');
      old?.remove();

      const iframe = document.createElement('iframe');
      iframe.id = '__sherpa_kws_frame__';
      iframe.src = 'about:blank';
      iframe.setAttribute('allow', 'microphone');
      iframe.style.cssText =
        'position:fixed;left:-10000px;top:-10000px;width:4px;height:4px;' +
        'opacity:0;pointer-events:none;border:0;';

      document.documentElement.appendChild(iframe);
      state.kwsIframe = iframe;

      await new Promise(resolve => {
        if (iframe.contentDocument?.readyState === 'complete') {
          resolve();
        } else {
          iframe.addEventListener('load', resolve, { once: true });
        }
      });

      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;

      doc.open();
      doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="${CFG.kwsAssetBase}">
</head>
<body></body>
</html>`);
      doc.close();

      // Wrapper defines createKws(); runtime provides Module and preloaded model data.
      showKwsProgress(
        40,
        '加载 KWS JavaScript',
        `正在载入 ${CFG.kwsWrapperScript}`
      );

      await loadScriptIntoKwsFrame(
        doc,
        CFG.kwsAssetBase + CFG.kwsWrapperScript
      );

      const runtimeReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('KWS WASM 初始化超时')),
          120000
        );

        win.Module = {
          onRuntimeInitialized() {
            clearTimeout(timeout);
            resolve();
          },
        };
      });

      showKwsProgress(
        55,
        '加载 KWS WASM',
        `正在载入 ${CFG.kwsRuntimeScript}`
      );

      await loadScriptIntoKwsFrame(
        doc,
        CFG.kwsAssetBase + CFG.kwsRuntimeScript
      );

      showKwsProgress(
        82,
        '初始化 KWS 运行时',
        '正在挂载模型并启动 WebAssembly…'
      );

      await runtimeReady;

      if (
        typeof win.createKws !== 'function' ||
        typeof win.Module?._malloc !== 'function'
      ) {
        throw new Error(
          'KWS runtime 无效：请确认 /sherpa-kws/ 中包含编译后的 js/wasm/data'
        );
      }

      showKwsProgress(
        93,
        '创建 KeywordSpotter',
        '正在配置 Nori 唤醒词…'
      );

      const config = {
        featConfig: {
          samplingRate: 16000,
          featureDim: 80,
        },
        modelConfig: {
          transducer: {
            encoder: CFG.kwsModel.encoder,
            decoder: CFG.kwsModel.decoder,
            joiner: CFG.kwsModel.joiner,
          },
          tokens: CFG.kwsModel.tokens,
          provider: 'cpu',
          modelType: '',
          numThreads: 1,
          debug: 0,
          modelingUnit: 'cjkchar',
          bpeVocab: '',
        },
        maxActivePaths: 4,
        numTrailingBlanks: 1,
        keywordsScore: 1.5,
        keywordsThreshold: 0.20,
        keywords: CFG.kwsKeywordTokens,
      };

      state.kws = win.createKws(win.Module, config);
      state.kwsStream = state.kws.createStream();
      state.kwsReady = true;

      finishKwsProgress();
      renderKwsMenuState('READY // NORI');
      log('sherpa-onnx KWS ready:', CFG.kwsKeywordTokens);
    })().catch(err => {
      state.kwsReady = false;
      state.kwsLoadingPromise = null;
      renderKwsMenuState('KWS ERROR');
      failKwsProgress(err?.message || err);
      throw err;
    });

    return state.kwsLoadingPromise;
  }

  function downsampleFloat32(input, inputRate, outputRate = 16000) {
    if (inputRate === outputRate) {
      return new Float32Array(input);
    }

    const ratio = inputRate / outputRate;
    const newLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const frac = srcPos - i0;
      output[i] =
        input[i0] * (1 - frac) +
        input[i1] * frac;
    }

    return output;
  }

  async function startKwsListening() {
    if (!state.kwsEnabled || state.kwsBusy) return;

    await ensureKwsLoaded();

    if (state.kwsMediaStream) {
      renderKwsMenuState('LISTENING // NORI');
      return;
    }

    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();

    const source = ctx.createMediaStreamSource(media);
    const processor = ctx.createScriptProcessor(2048, 1, 1);

    processor.onaudioprocess = ev => {
      if (
        !state.kwsEnabled ||
        state.kwsBusy ||
        !state.kwsReady ||
        !state.kwsStream
      ) {
        return;
      }

      try {
        const input = ev.inputBuffer.getChannelData(0);
        const samples = downsampleFloat32(
          input,
          ctx.sampleRate,
          16000
        );

        state.kwsStream.acceptWaveform(16000, samples);

        while (state.kws.isReady(state.kwsStream)) {
          state.kws.decode(state.kwsStream);

          const result = state.kws.getResult(state.kwsStream);
          const keyword = String(result?.keyword || '').trim();

          if (keyword) {
            state.kws.reset(state.kwsStream);

            if (
              keyword.toUpperCase() ===
              CFG.kwsKeywordLabel.toUpperCase()
            ) {
              log('KWS detected:', keyword);
              void handleKwsWake();
              break;
            }
          }
        }
      } catch (err) {
        warn('KWS audio processing error:', err);
      }
    };

    // Keep processor alive without audible output.
    const mute = ctx.createGain();
    mute.gain.value = 0;

    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    state.kwsMediaStream = media;
    state.kwsAudioContext = ctx;
    state.kwsSource = source;
    state.kwsProcessor = processor;

    renderKwsMenuState('LISTENING // NORI');
  }

  async function stopKwsListening() {
    try {
      if (state.kwsProcessor) {
        state.kwsProcessor.onaudioprocess = null;
        state.kwsProcessor.disconnect();
      }
    } catch {}

    try { state.kwsSource?.disconnect(); } catch {}

    try {
      for (const track of state.kwsMediaStream?.getTracks?.() || []) {
        track.stop();
      }
    } catch {}

    try {
      if (state.kwsAudioContext?.state !== 'closed') {
        await state.kwsAudioContext?.close();
      }
    } catch {}

    state.kwsProcessor = null;
    state.kwsSource = null;
    state.kwsMediaStream = null;
    state.kwsAudioContext = null;
  }

  async function runAsrAfterWake() {
    await ensureSherpaLoaded();

    const doc = frameDoc();
    const clear = doc.getElementById('clearBtn');
    const start = doc.getElementById('startBtn');
    const stop = doc.getElementById('stopBtn');

    clear?.click();

    if (!start || start.disabled) {
      throw new Error('ASR 尚未就绪');
    }

    // KWS has fired: make the input frame visibly "armed/recording".
    setTriggeredInputVisual(true);

    setButtonState('recording');
    start.click();

    const deadline = Date.now() + CFG.wakeCommandTimeoutMs;
    let result = '';
    let firstResultAt = 0;
    let lastResult = '';
    let lastResultChangedAt = 0;

    while (Date.now() < deadline) {
      await sleep(100);

      const now = currentTranscript();

      if (!now) {
        continue;
      }

      // A valid Result: is emitted by the sherpa VAD+ASR pipeline only
      // after the detected speech segment reaches an endpoint.
      if (!firstResultAt) {
        firstResultAt = Date.now();
        lastResultChangedAt = firstResultAt;
        lastResult = now;
        result = now;

        setButtonState('recognizing');
        log('VAD endpoint detected; waiting for final Result:', now);
        continue;
      }

      if (now !== lastResult) {
        lastResult = now;
        result = now;
        lastResultChangedAt = Date.now();
      }

      // Auto-end: once a valid Result exists and has remained stable for
      // a short period, stop the microphone automatically.
      if (
        Date.now() - lastResultChangedAt >=
        CFG.vadAutoEndSettleMs
      ) {
        log('VAD auto-end: Result stable, stopping ASR');
        break;
      }
    }

    if (stop && !stop.disabled) {
      stop.click();
    }

    setButtonState('recognizing');

    // Stop may flush one final ASR update. Keep strict Result-only parsing.
    const afterStop = await waitForStableTranscript(result);
    if (afterStop) result = afterStop;

    if (!result) {
      setTriggeredInputVisual(false);
      setButtonState('idle');
      log('wake ASR: no valid Result');
      return;
    }

    const input = document.querySelector(CFG.input);
    if (!input) {
      setTriggeredInputVisual(false);
      throw new Error(`未找到输入框: ${CFG.input}`);
    }

    const max = Number(input.getAttribute('maxlength')) || 100;
    const text = Array.from(result).slice(0, max).join('');

    setReactInputValue(input, text);

    // Recognition is complete; restore the normal input frame immediately.
    setTriggeredInputVisual(false);

    scheduleRecognizedSubmission(input, text);

    setButtonState('idle');
  }

  async function handleKwsWake() {
    if (state.kwsBusy || !state.kwsEnabled) return;

    state.kwsBusy = true;
    renderKwsMenuState('WAKE // NORI');

    try {
      // Release microphone before the existing VAD+ASR demo acquires it.
      await stopKwsListening();

      state.micButton?.animate?.(
        [
          { filter: 'drop-shadow(0 0 0 rgba(110,244,255,0))' },
          { filter: 'drop-shadow(0 0 10px rgba(110,244,255,.9))' },
          { filter: 'drop-shadow(0 0 0 rgba(110,244,255,0))' },
        ],
        { duration: 520, easing: 'ease-out' }
      );

      await runAsrAfterWake();
    } catch (err) {
      warn('wake->ASR failed:', err);
      setTriggeredInputVisual(false);
      setButtonState('error');
    } finally {
      // Defensive restore in case React replaced the input or any async
      // operation aborted before runAsrAfterWake() reached its normal end.
      setTriggeredInputVisual(false);
      state.kwsBusy = false;

      if (state.kwsEnabled && !state.destroyed) {
        try {
          await sleep(350);
          await startKwsListening();
        } catch (err) {
          warn('failed to resume KWS:', err);
          renderKwsMenuState('KWS RESUME ERROR');
        }
      }
    }
  }

  async function setKwsEnabled(enabled) {
    state.kwsEnabled = !!enabled;
    saveKwsEnabledPreference(state.kwsEnabled);

    if (!state.kwsEnabled) {
      await stopKwsListening();
      renderKwsMenuState('OFFLINE');
      return;
    }

    renderKwsMenuState('INITIALIZING KWS…');

    try {
      await ensureKwsLoaded();
      await startKwsListening();
    } catch (err) {
      state.kwsEnabled = false;
      saveKwsEnabledPreference(false);

      const isMissingAsset =
        /资产|HTML|HTTP|WASM|DATA|无法访问/i.test(
          String(err?.message || err)
        );

      renderKwsMenuState(
        isMissingAsset
          ? 'KWS ASSETS MISSING'
          : 'KWS LOAD ERROR'
      );

      failKwsProgress(err?.message || err);

      warn(
        'KWS enable failed.',
        '\nKWS asset base:', CFG.kwsAssetBase,
        '\nExpected:',
        '\n  ' + CFG.kwsWrapperScript,
        '\n  ' + CFG.kwsRuntimeScript,
        '\n  sherpa-onnx-wasm-kws-main.wasm',
        '\n  sherpa-onnx-wasm-kws-main.data',
        '\nError:', err
      );

      // Do not disturb ASR HUD; use a compact menu status plus console error.
    }
  }

  function createSherpaIframe() {
    const old = document.getElementById('__sherpa_v3_isolated_frame__');
    old?.remove();

    const iframe = document.createElement('iframe');
    iframe.id = '__sherpa_v3_isolated_frame__';

    // about:blank is same-origin with the host document, but has its own
    // JavaScript global realm. This isolates Emscripten's global Module.
    iframe.src = 'about:blank';
    iframe.setAttribute('allow', 'microphone');

    // Keep it rendered (not display:none), because media APIs can behave
    // differently in fully non-rendered frames. Put it off-screen instead.
    iframe.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:-10000px',
      'width:320px',
      'height:240px',
      'opacity:0',
      'pointer-events:none',
      'border:0',
      'z-index:-2147483648',
    ].join(';');

    document.documentElement.appendChild(iframe);
    state.iframe = iframe;
    state.iframeWindow = iframe.contentWindow;

    return iframe;
  }

  async function loadScriptIntoFrame(doc, url) {
    return new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`iframe 脚本加载失败: ${url}`));
      doc.head.appendChild(s);
    });
  }

  async function ensureSherpaLoaded() {
    if (state.ready) return;
    if (state.loadingPromise) return state.loadingPromise;

    state.loadingPromise = (async () => {
      setButtonState('loading');
      createProgressOverlay();
      updateProgress(2, '准备运行环境', '正在创建隔离 WASM 容器…');

      const iframe = createSherpaIframe();

      // Wait until about:blank is usable.
      await new Promise(resolve => {
        if (iframe.contentDocument?.readyState === 'complete') {
          resolve();
        } else {
          iframe.addEventListener('load', resolve, { once: true });
        }
      });

      if (state.destroyed) throw new Error('已销毁');

      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;

      if (!win || !doc) {
        throw new Error('无法访问 sherpa 隔离 iframe');
      }

      updateProgress(5, '准备运行环境', '隔离容器已建立');

      // Build the DOM expected by the official app-vad-asr.js.
      doc.open();
      doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="${CFG.assetBase}">
</head>
<body>
  <div id="status">Loading...</div>
  <button id="startBtn" type="button" disabled>Start</button>
  <button id="stopBtn" type="button" disabled>Stop</button>
  <button id="clearBtn" type="button">Clear</button>
  <textarea id="results" readonly></textarea>
  <section id="sound-clips"></section>
</body>
</html>`);
      doc.close();

      const cachedModel = await prepareCachedModelBlob();
      installCachedDataXhr(win, cachedModel.blob);

      updateProgress(
        cachedModel.fromCache ? 86 : 93,
        cachedModel.fromCache
          ? '正在从本地缓存恢复模型'
          : '加载识别组件',
        cachedModel.fromCache
          ? 'IndexedDB // 准备挂载到 WASM'
          : '模型缓存准备完成'
      );

      // IMPORTANT:
      // Load every official file in the iframe's own global realm.
      // Do not create/modify parent window.Module at all.
      for (let i = 0; i < CFG.scripts.length; i++) {
        const file = CFG.scripts[i];
        log('iframe load:', file);

        if (file !== 'sherpa-onnx-wasm-main-vad-asr.js') {
          updateProgress(
            cachedModel.fromCache ? 87 + i : 93 + i * 0.5,
            '加载识别组件',
            `正在载入 ${file}`
          );
        } else {
          updateProgress(
            cachedModel.fromCache ? 90 : 95,
            '启动 WASM 运行时',
            cachedModel.fromCache
              ? '模型数据将从 IndexedDB 提供给 Emscripten…'
              : '正在启动本地语音识别运行时…'
          );
        }

        await loadScriptIntoFrame(doc, CFG.assetBase + file);
      }

      updateProgress(97, '初始化语音识别引擎', '正在创建 VAD / ASR 实例…');

      const deadline = Date.now() + CFG.initTimeoutMs;

      while (Date.now() < deadline) {
        if (state.destroyed) throw new Error('已销毁');

        const start = doc.getElementById('startBtn');
        const stop = doc.getElementById('stopBtn');

        // _malloc is a useful sanity check that we are looking at the
        // Emscripten Module that actually received the runtime exports.
        const moduleLooksValid =
          win.Module &&
          typeof win.Module._malloc === 'function';

        if (start && stop && !start.disabled && moduleLooksValid) {
          state.ready = true;
          setButtonState('idle');
          finishProgress();
          log(
            'sherpa-onnx 已在隔离 iframe 初始化完成',
            'Module._malloc =', typeof win.Module._malloc
          );
          return;
        }

        await sleep(200);
      }

      const mallocType = typeof win.Module?._malloc;
      const status = doc.getElementById('status')?.textContent ?? '';

      throw new Error(
        `sherpa iframe 初始化超时；Module._malloc=${mallocType}; status=${status}`
      );
    })().catch(err => {
      state.ready = false;
      state.loadingPromise = null;
      setButtonState('error');
      failProgress(err?.message || err);
      throw err;
    });

    return state.loadingPromise;
  }

  function frameDoc() {
    const doc = state.iframe?.contentDocument;
    if (!doc) throw new Error('sherpa iframe 不存在');
    return doc;
  }

  function extractTranscript(raw) {
    const lines = String(raw || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const results = [];

    for (const line of lines) {
      // Strict: only accept lines containing "Result:".
      const m = line.match(/\bResult\s*:\s*(.*)$/iu);
      if (!m) continue;

      const text = m[1].trim();
      if (text) results.push(text);
    }

    return results.join('').trim();
  }

  function currentTranscript() {
    const textarea = frameDoc().getElementById('results');
    return extractTranscript(textarea?.value ?? '');
  }

  async function waitForStableTranscript(initial = '') {
    const deadline = Date.now() + CFG.recognitionTimeoutMs;
    let last = initial;
    let lastChange = Date.now();

    while (Date.now() < deadline) {
      await sleep(CFG.recognitionPollMs);

      const now = currentTranscript();

      if (now !== last) {
        last = now;
        lastChange = Date.now();
      }

      if (last && Date.now() - lastChange >= CFG.resultStableMs) {
        return last;
      }
    }

    return last;
  }


  function setTriggeredInputVisual(active) {
    const input = document.querySelector(CFG.input);
    const frame = input?.parentElement;

    if (!frame) return;

    if (active) {
      // If React replaced the input wrapper, restore the previous one first.
      if (
        state.activeInputFrame &&
        state.activeInputFrame !== frame
      ) {
        try {
          state.activeInputFrame.style.border =
            state.activeInputFramePrevBorder ?? '';
          state.activeInputFrame.style.boxShadow =
            state.activeInputFramePrevBoxShadow ?? '';
          state.activeInputFrame.style.transition =
            state.activeInputFramePrevTransition ?? '';
        } catch {}
      }

      if (state.activeInputFrame !== frame) {
        state.activeInputFrame = frame;
        state.activeInputFramePrevBorder = frame.style.border;
        state.activeInputFramePrevBoxShadow = frame.style.boxShadow;
        state.activeInputFramePrevTransition = frame.style.transition;
      }

      // Replace the page's normal:
      // border: 1px solid rgba(210, 232, 233, 0.125)
      // with a clear KWS-triggered/ASR-active indicator.
      frame.style.transition =
        'border-color .14s ease, border-width .14s ease, box-shadow .14s ease';
      frame.style.border = '2px solid rgba(255, 74, 74, 0.95)';
      frame.style.boxShadow =
        '0 0 0 1px rgba(255, 74, 74, 0.16) inset, ' +
        '0 0 12px rgba(255, 52, 52, 0.22)';
      return;
    }

    if (state.activeInputFrame) {
      try {
        state.activeInputFrame.style.border =
          state.activeInputFramePrevBorder ?? '';
        state.activeInputFrame.style.boxShadow =
          state.activeInputFramePrevBoxShadow ?? '';
        state.activeInputFrame.style.transition =
          state.activeInputFramePrevTransition ?? '';
      } catch {}
    }

    state.activeInputFrame = null;
    state.activeInputFramePrevBorder = null;
    state.activeInputFramePrevBoxShadow = null;
    state.activeInputFramePrevTransition = null;
  }

  function setReactInputValue(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter =
      Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

    // React controlled input compatibility.
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: value,
      }));
    } catch {
      input.dispatchEvent(new Event('input', {
        bubbles: true,
        composed: true,
      }));
    }

    input.dispatchEvent(new Event('change', {
      bubbles: true,
      composed: true,
    }));
  }

  function submitRecognizedInput(input) {
    if (!input?.isConnected) return false;

    // 1) Prefer a submit button that is a DIRECT sibling of the input.
    //
    // Example:
    // <div>
    //   <input maxlength="100">
    //   <button type="submit">...</button>
    // </div>
    //
    // Calling .click() preserves the page/framework's normal button handlers.
    const parent = input.parentElement;

    if (parent) {
      for (const child of parent.children) {
        if (
          child !== input &&
          child instanceof HTMLButtonElement &&
          String(child.type).toLowerCase() === 'submit' &&
          !child.disabled
        ) {
          log('submit via sibling button[type=submit]');
          child.click();
          return true;
        }
      }
    }

    // 2) Otherwise submit the associated/closest form through requestSubmit().
    // requestSubmit() preserves constraint validation and dispatches a normal
    // submit event, unlike form.submit(), which bypasses submit handlers.
    const form =
      input.form ||
      input.closest?.('form');

    if (form) {
      if (typeof form.requestSubmit === 'function') {
        log('submit via form.requestSubmit()');
        form.requestSubmit();
        return true;
      }

      // Extremely old-browser fallback: dispatch a cancelable submit event.
      // Do NOT call form.submit(), because that bypasses framework submit logic.
      const event = new Event('submit', {
        bubbles: true,
        cancelable: true,
      });

      log('submit via synthetic form submit event');
      return form.dispatchEvent(event);
    }

    warn(
      'recognized text was entered, but no sibling button[type=submit] ' +
      'or containing form was found; submission skipped'
    );

    return false;
  }

  function scheduleRecognizedSubmission(input, text) {
    const normalized = String(text || '').trim();
    if (!normalized || !input?.isConnected) return false;

    const now = Date.now();

    // KWS/VAD may expose the same final Result twice while Stop flushes.
    if (
      normalized === state.lastSubmittedText &&
      now - state.lastSubmittedAt < state.submitDedupWindowMs
    ) {
      log(
        'duplicate submit suppressed:',
        normalized,
        `${now - state.lastSubmittedAt}ms`
      );
      return false;
    }

    clearTimeout(state.submitTimer);

    // Invalidate every older scheduled submission.
    const generation = ++state.submitGeneration;

    state.submitTimer = setTimeout(() => {
      if (
        state.destroyed ||
        generation !== state.submitGeneration ||
        !input.isConnected
      ) {
        return;
      }

      const firedAt = Date.now();

      if (
        normalized === state.lastSubmittedText &&
        firedAt - state.lastSubmittedAt < state.submitDedupWindowMs
      ) {
        log('duplicate submit suppressed at dispatch:', normalized);
        return;
      }

      state.lastSubmittedText = normalized;
      state.lastSubmittedAt = firedAt;

      log('submit recognized text:', normalized);
      submitRecognizedInput(input);
    }, CFG.submitDelayMs);

    return true;
  }

  async function beginHold(e) {
    if (state.destroyed || state.isHolding) return;

    e.preventDefault();
    e.stopPropagation();

    state.isHolding = true;

    try {
      state.micButton?.setPointerCapture?.(e.pointerId);
    } catch {}

    try {
      await ensureSherpaLoaded();

      // The user may have released while the large model was still loading.
      if (!state.isHolding || state.destroyed) return;

      const doc = frameDoc();
      const clear = doc.getElementById('clearBtn');
      const start = doc.getElementById('startBtn');

      clear?.click();

      if (!start || start.disabled) {
        throw new Error('sherpa Start 尚未就绪');
      }

      start.click();
      setButtonState('recording');
    } catch (err) {
      state.isHolding = false;
      setButtonState('error');
      warn(err);
    }
  }

  async function endHold(e) {
    if (state.destroyed || !state.isHolding) return;

    e?.preventDefault?.();
    e?.stopPropagation?.();

    state.isHolding = false;

    try {
      // If model is still loading and recording never started, just return.
      if (!state.ready) {
        setButtonState('loading');
        return;
      }

      const doc = frameDoc();
      const stop = doc.getElementById('stopBtn');

      setButtonState('recognizing');

      if (stop && !stop.disabled) {
        stop.click();
      }

      // Do not use the "before" transcript as a requirement:
      // the official demo may only append the final ASR result after Stop.
      const result = await waitForStableTranscript('');

      if (!result) {
        setButtonState('idle');
        log('本次没有识别到文本');
        return;
      }

      const input = document.querySelector(CFG.input);
      if (!input) {
        throw new Error(`未找到输入框: ${CFG.input}`);
      }

      const max = Number(input.getAttribute('maxlength')) || 100;
      const text = Array.from(result).slice(0, max).join('');

      log('recognized:', text);

      setReactInputValue(input, text);

      scheduleRecognizedSubmission(input, text);

      setButtonState('idle');
    } catch (err) {
      setButtonState('error');
      warn(err);
    }
  }

  function attachButton() {
    if (state.destroyed) return false;

    const reference = document.querySelector(CFG.analysisButton);
    if (!reference?.parentNode) return false;

    const old =
      document.querySelector('[data-sherpa-mic-button-v3="1"]');

    if (old) {
      state.micButton = old;
      if (!old.dataset.sherpaContextMenuAttached) {
        attachContextMenu(old);
        old.dataset.sherpaContextMenuAttached = '1';
      }
      if (old.parentNode !== reference.parentNode ||
          old.nextSibling !== reference) {
        reference.parentNode.insertBefore(old, reference);
      }
      return true;
    }

    const btn = buildMicButton(reference);
    state.micButton = btn;
    attachContextMenu(btn);
    btn.dataset.sherpaContextMenuAttached = '1';

    btn.addEventListener('pointerdown', beginHold, {
      passive: false,
    });
    btn.addEventListener('pointerup', endHold, {
      passive: false,
    });
    btn.addEventListener('pointercancel', endHold, {
      passive: false,
    });
    btn.addEventListener('lostpointercapture', () => {
      if (state.isHolding) endHold();
    });

    btn.addEventListener('keydown', e => {
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        beginHold(e);
      }
    });

    btn.addEventListener('keyup', e => {
      if (e.code === 'Space' || e.key === ' ') {
        endHold(e);
      }
    });

    reference.parentNode.insertBefore(btn, reference);
    setButtonState('idle');

    // Warm-load the 300+ MB model. Microphone recording still starts only
    // from the actual pointer/keyboard hold action.
    ensureSherpaLoaded().catch(warn);

    if (!state.kwsEnabled && loadKwsEnabledPreference()) {
      state.kwsEnabled = true;
      void setKwsEnabled(true);
    }

    return true;
  }


  document.addEventListener('pointerdown', e => {
    if (
      state.menu?.style.display !== 'none' &&
      !state.menu?.contains(e.target)
    ) {
      toggleVoiceMenu(false);
    }
  }, true);

  function watchReactRerenders() {
    const observer = new MutationObserver(() => {
      if (state.destroyed) return;

      const reference = document.querySelector(CFG.analysisButton);
      if (!reference?.parentNode) return;

      if (!state.micButton?.isConnected) {
        attachButton();
        return;
      }

      if (
        state.micButton.parentNode !== reference.parentNode ||
        state.micButton.nextSibling !== reference
      ) {
        reference.parentNode.insertBefore(state.micButton, reference);
      }

      if (!state.isHolding) {
        refreshAppearance();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    state.observers.push(observer);
  }

  state.destroy = () => {
    state.destroyed = true;
    clearTimeout(state.submitTimer);
    state.submitGeneration++;
    setTriggeredInputVisual(false);

    try {
      const doc = state.iframe?.contentDocument;
      const stop = doc?.getElementById('stopBtn');
      if (stop && !stop.disabled) stop.click();
    } catch {}

    state.observers.forEach(o => o.disconnect());
    void stopKwsListening();
    try { state.kwsStream?.free?.(); } catch {}
    try { state.kws?.free?.(); } catch {}
    state.kwsIframe?.remove();
    state.menu?.remove();

    state.micButton?.remove();
    state.iframe?.remove();
    state.progressOverlay?.remove();
    document.getElementById('__sherpa_norios_progress_style__')?.remove();

    delete window[KEY];
  };

  if (!attachButton()) {
    const retry = new MutationObserver(() => {
      if (attachButton()) retry.disconnect();
    });

    retry.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    state.observers.push(retry);
  }

  watchReactRerenders();
})();