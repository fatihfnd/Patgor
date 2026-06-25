/**
 * app.js — Ana uygulama mantığı
 * Gereksinimler:
 *  - OpenCV hazır olana kadar işleme butonları disabled
 *  - Tüm işleme try/catch/finally — finally'de overlay HER ZAMAN kapanır
 *  - 60 sn zaman aşımı
 *  - Hata olursa ekranda kırmızı hata kutusu
 *  - Büyük görüntüler (>1500px) işleme öncesi küçültülür, sonra orijinal boyuta döner
 *  - Referans görüntü opsiyonel; varsayılan presetler her zaman aktif
 */

/* ── Sabitler ────────────────────────────────────────────── */
const PROCESS_TIMEOUT_MS = 60_000;
const MAX_PROCESS_PX     = 1500; // işleme için max kenar (piksel)

/* ── Durum ───────────────────────────────────────────────── */
const state = {
  files:        [],
  activeIdx:    -1,
  viewMode:     'split',
  zoom:         1.0,
  openCVReady:  false,
  sliderX:      0.5,
};

/* ── DOM ─────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

// Tüm referansları sayfa yüklendikten sonra doldur
let dom = {};
function initDom() {
  dom = {
    dropZone:           $('dropZone'),
    fileInput:          $('fileInput'),
    refInput:           $('refInput'),
    thumbBar:           $('thumbBar'),
    canvasEmpty:        $('canvasEmpty'),
    viewerWrap:         $('viewerWrap'),
    splitView:          $('splitView'),
    sliderView:         $('sliderView'),
    canvasBefore:       $('canvasBefore'),
    canvasAfter:        $('canvasAfter'),
    canvasSliderBase:   $('canvasSliderBase'),
    canvasSliderTop:    $('canvasSliderTop'),
    sliderHandle:       $('sliderHandle'),
    sliderOverlay:      $('sliderOverlay'),
    processingOverlay:  $('processingOverlay'),
    processingMsg:      $('processingMsg'),
    progressBar:        $('progressBar'),
    statusBar:          $('statusBar'),
    batchList:          $('batchList'),
    infoSize:           $('infoSize'),
    infoFormat:         $('infoFormat'),
    infoStain:          $('infoStain'),
    infoStatus:         $('infoStatus'),
    zoomLabel:          $('zoomLabel'),
    jpgQualityRow:      $('jpgQualityRow'),
    refThumb:           $('refThumb'),
    errorBox:           $('errorBox'),
    errorMsg:           $('errorMsg'),
    btnAutoProcess:     $('btnAutoProcess'),
    btnApplyManual:     $('btnApplyManual'),
    btnBatchProcess:    $('btnBatchProcess'),
  };
}

/* ── Hata kutusu ─────────────────────────────────────────── */
function showError(msg) {
  console.error('[PaToGörüntü] HATA:', msg);
  if (!dom.errorBox) return;
  dom.errorMsg.textContent = msg;
  dom.errorBox.hidden = false;
  // 10 sn sonra otomatik kapat
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => { dom.errorBox.hidden = true; }, 10_000);
}

function hideError() {
  if (dom.errorBox) dom.errorBox.hidden = true;
}

/* ── Durum çubuğu ────────────────────────────────────────── */
function setStatus(msg, type = '') {
  if (!dom.statusBar) return;
  dom.statusBar.textContent = msg;
  dom.statusBar.style.color =
    type === 'error' ? 'var(--danger)'  :
    type === 'ok'    ? 'var(--success)' : 'var(--text-dim)';
}

/* ── İşleme butonları: kilitle / aç ─────────────────────── */
function setProcessingButtons(enabled) {
  [dom.btnAutoProcess, dom.btnApplyManual, dom.btnBatchProcess].forEach(btn => {
    if (!btn) return;
    btn.disabled = !enabled;
  });
}

/* ── OpenCV başlatma ─────────────────────────────────────── */
function initOpenCV() {
  // Butonlar başta disabled
  setProcessingButtons(false);
  setStatus('OpenCV yükleniyor…');

  const onReady = () => {
    state.openCVReady = true;
    setProcessingButtons(true);
    setStatus('Hazır — OpenCV yüklü', 'ok');
    console.log('[app] OpenCV hazır');
  };

  // Module.onRuntimeInitialized zaten index.html'de ayarlı;
  // bu event'i dinlemek yeterli.
  if (window.openCVReady) {
    onReady();
  } else {
    window.addEventListener('opencv-ready', onReady, { once: true });
  }
}

/* ── Görüntü yükleme ─────────────────────────────────────── */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['tif', 'tiff'].includes(ext)) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const buf  = e.target.result;
          const ifds = UTIF.decode(buf);
          UTIF.decodeImage(buf, ifds[0]);
          const rgba = UTIF.toRGBA8(ifds[0]);
          const w = ifds[0].width, h = ifds[0].height;
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
          resolve(c);
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görüntü yüklenemedi')); };
      img.src = url;
    }
  });
}

/* ── Büyük görüntü ölçekleme ─────────────────────────────── */
function downscaleCanvas(canvas, maxPx) {
  const { width: w, height: h } = canvas;
  if (Math.max(w, h) <= maxPx) return { canvas, scale: 1 };
  const scale = maxPx / Math.max(w, h);
  const sw = Math.round(w * scale), sh = Math.round(h * scale);
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
  console.log('[app] görüntü küçültüldü: ' + w + 'x' + h + ' → ' + sw + 'x' + sh);
  return { canvas: c, scale };
}

function upscaleCanvas(small, targetW, targetH) {
  const c = document.createElement('canvas');
  c.width = targetW; c.height = targetH;
  c.getContext('2d').drawImage(small, 0, 0, targetW, targetH);
  return c;
}

/* ── Thumbnail ───────────────────────────────────────────── */
function createThumb(canvas, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb-item';
  wrap.title = state.files[idx].name;
  const tc = document.createElement('canvas');
  tc.width = 46; tc.height = 46;
  const ratio = Math.min(46 / canvas.width, 46 / canvas.height);
  const tw = canvas.width * ratio, th = canvas.height * ratio;
  tc.getContext('2d').drawImage(canvas, (46 - tw) / 2, (46 - th) / 2, tw, th);
  const img = document.createElement('img');
  img.src = tc.toDataURL('image/jpeg', 0.7);
  wrap.appendChild(img);
  wrap.addEventListener('click', () => activateImage(idx));
  dom.thumbBar.appendChild(wrap);
  return wrap;
}

/* ── Dosyaları ekle ──────────────────────────────────────── */
async function addFiles(files) {
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(ext)) continue;
    setStatus('Yükleniyor: ' + file.name);
    try {
      const canvas = await loadImageFile(file);
      const entry  = {
        file, name: file.name,
        origCanvas: canvas, resultCanvas: null,
        processed: false, stainType: '—',
      };
      const idx = state.files.length;
      state.files.push(entry);
      entry.thumb = createThumb(canvas, idx);

      const bItem = document.createElement('div');
      bItem.className = 'batch-item';
      bItem.innerHTML = `<div class="batch-dot pending"></div>
        <span class="batch-item-name">${file.name}</span>`;
      entry.batchItem = bItem;
      dom.batchList.appendChild(bItem);

      if (state.activeIdx === -1) activateImage(0);
    } catch (err) {
      showError('Yükleme hatası: ' + file.name + ' — ' + err.message);
    }
  }
  setStatus(state.files.length + ' görüntü yüklendi', 'ok');
}

/* ── Aktif görüntü ───────────────────────────────────────── */
function activateImage(idx) {
  state.activeIdx = idx;
  dom.thumbBar.querySelectorAll('.thumb-item').forEach((t, i) =>
    t.classList.toggle('active', i === idx));

  const entry = state.files[idx];
  dom.infoSize.textContent   = entry.origCanvas.width + ' × ' + entry.origCanvas.height + ' px';
  dom.infoFormat.textContent = entry.name.split('.').pop().toUpperCase();
  dom.infoStain.textContent  = entry.stainType;
  dom.infoStatus.textContent = entry.processed ? 'İşlendi' : 'Bekliyor';

  dom.canvasEmpty.hidden = true;
  dom.viewerWrap.hidden  = false;

  drawToCanvas(entry.origCanvas,                       dom.canvasBefore);
  drawToCanvas(entry.resultCanvas || entry.origCanvas, dom.canvasAfter);
  updateSliderCanvases();
  applyZoom();
}

function drawToCanvas(src, dst) {
  dst.width  = src.width;
  dst.height = src.height;
  dst.getContext('2d').drawImage(src, 0, 0);
}

function updateSliderCanvases() {
  if (state.activeIdx < 0) return;
  const e = state.files[state.activeIdx];
  drawToCanvas(e.origCanvas,                   dom.canvasSliderBase);
  drawToCanvas(e.resultCanvas || e.origCanvas, dom.canvasSliderTop);
  // Layout sonrası top canvas'ı base canvas display boyutuna eşitle
  requestAnimationFrame(() => {
    const dw = dom.canvasSliderBase.offsetWidth;
    const dh = dom.canvasSliderBase.offsetHeight;
    if (dw > 0) {
      dom.canvasSliderTop.style.width  = dw + 'px';
      dom.canvasSliderTop.style.height = dh + 'px';
    }
    updateSliderPosition();
  });
}

function applyZoom() {
  const z = state.zoom;
  dom.zoomLabel.textContent = Math.round(z * 100) + '%';
  [dom.canvasBefore, dom.canvasAfter,
   dom.canvasSliderBase, dom.canvasSliderTop].forEach(c => {
    c.style.transform = 'scale(' + z + ')';
  });
}

function setViewMode(mode) {
  state.viewMode = mode;
  dom.splitView.hidden  = mode !== 'split';
  dom.sliderView.hidden = mode !== 'slider';
  if (mode === 'after') {
    dom.splitView.hidden = false;
    dom.canvasBefore.parentElement.style.display = 'none';
  } else {
    dom.canvasBefore.parentElement.style.display = '';
  }
  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === mode));
  if (mode === 'slider') updateSliderCanvases();
}

function updateSliderPosition() {
  // offsetWidth = CSS display genişliği (piksel genişliği değil)
  const displayW = dom.canvasSliderBase.offsetWidth || dom.canvasSliderBase.width;
  const px = displayW * state.sliderX;
  dom.sliderHandle.style.left   = px + 'px';
  dom.sliderOverlay.style.width = px + 'px';
}

function initSliderDrag() {
  let dragging = false;
  dom.sliderHandle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = dom.canvasSliderBase.getBoundingClientRect();
    state.sliderX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    updateSliderPosition();
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

/* ── Overlay ─────────────────────────────────────────────── */
function showProcessing(show, msg = 'İşleniyor…') {
  // style.display kullan — CSS [hidden] override sorununa karşı güvenli yol
  dom.processingOverlay.style.display = show ? 'flex' : 'none';
  dom.processingMsg.textContent = msg;
  if (!show) {
    dom.progressBar.style.width = '0%';
    console.log('[app] ✓ overlay kapatıldı');
  } else {
    console.log('[app] overlay açıldı:', msg);
  }
}

function setProgress(pct, msg) {
  dom.progressBar.style.width = pct + '%';
  if (msg) dom.processingMsg.textContent = msg;
}

/* ── Zaman aşımı sarmalayıcısı ───────────────────────────── */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('İşlem zaman aşımına uğradı (' + ms / 1000 + ' sn)')),
      ms
    );
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

/* ── İşleme seçenekleri ──────────────────────────────────── */
function getProcessingOpts() {
  return {
    flatField:         $('chkFlatField').checked,
    whiteBalance:      $('chkWhiteBalance').checked,
    stainNorm:         $('chkStainNorm').checked,
    clahe:             $('chkClahe').checked,
    sharpen:           $('chkSharpen').checked,
    stainType:         document.querySelector('input[name="stain"]:checked').value,
    flatFieldStrength: parseInt($('sFlatField').value),
    sharpenAmount:     parseInt($('sSharpen').value),
    hemaScale:         parseInt($('sHema').value),
    eosinScale:        parseInt($('sEosin').value),
    dabScale:          parseInt($('sDAB').value),
    brightness:        parseInt($('sBrightness').value),
    contrast:          parseInt($('sContrast').value),
    saturation:        parseInt($('sSaturation').value),
    temperature:       parseInt($('sTemperature').value),
    applyManual:       false,
  };
}

/* ── Ana işleme ──────────────────────────────────────────── */
async function processActive() {
  if (state.activeIdx < 0) { showError('Önce bir görüntü yükleyin.'); return; }
  if (!state.openCVReady)  { showError('OpenCV henüz hazır değil, lütfen bekleyin.'); return; }

  const entry  = state.files[state.activeIdx];
  const origW  = entry.origCanvas.width;
  const origH  = entry.origCanvas.height;

  hideError();
  showProcessing(true, 'Hazırlanıyor…');
  setStatus('İşleniyor: ' + entry.name);
  setProcessingButtons(false);

  try {
    const opts = getProcessingOpts();

    // Büyük görüntü → küçült (renk düzeltmesi için yeterli)
    const { canvas: workCanvas, scale } = downscaleCanvas(entry.origCanvas, MAX_PROCESS_PX);

    const { imgData, stainType } = await withTimeout(
      Pipeline.process(workCanvas, opts, (pct, msg) => setProgress(pct, msg)),
      PROCESS_TIMEOUT_MS
    );

    // Küçük sonuç canvas'ı
    const smallResult = document.createElement('canvas');
    smallResult.width  = imgData.width;
    smallResult.height = imgData.height;
    smallResult.getContext('2d').putImageData(imgData, 0, 0);

    // Orijinal boyuta geri döndür (gerekiyorsa)
    const result = scale < 1
      ? upscaleCanvas(smallResult, origW, origH)
      : smallResult;

    entry.resultCanvas = result;
    entry.processed    = true;
    entry.stainType    = stainType === 'ihk' ? 'İHK (DAB)' : 'H&E';

    // Thumbnail rozetini güncelle
    const badge = entry.thumb.querySelector('.thumb-status') || document.createElement('span');
    badge.className  = 'thumb-status done';
    badge.textContent = '✓';
    entry.thumb.appendChild(badge);

    if (entry.batchItem)
      entry.batchItem.querySelector('.batch-dot').className = 'batch-dot done';

    dom.infoStain.textContent  = entry.stainType;
    dom.infoStatus.textContent = 'İşlendi';
    drawToCanvas(result, dom.canvasAfter);
    updateSliderCanvases();
    setStatus('İşlendi: ' + entry.name, 'ok');

  } catch (err) {
    console.error('[app] processActive hatası:', err.stack || err);
    showError('İşleme hatası: ' + err.message);
    setStatus('Hata: ' + err.message, 'error');
    if (entry.batchItem)
      entry.batchItem.querySelector('.batch-dot').className = 'batch-dot error';

  } finally {
    console.log('[app] processActive finally — overlay kapatılıyor');
    showProcessing(false);       // HER DURUMDA kapat
    setProcessingButtons(true);  // HER DURUMDA butonları aç
  }
}

/* ── Manuel ayar uygula ──────────────────────────────────── */
async function applyManualOpts() {
  if (state.activeIdx < 0) { showError('Önce bir görüntü yükleyin.'); return; }
  if (!state.openCVReady)  { showError('OpenCV henüz hazır değil.'); return; }

  const entry = state.files[state.activeIdx];
  hideError();
  showProcessing(true, 'Manuel ayarlar uygulanıyor…');
  setProcessingButtons(false);

  try {
    const opts = {
      ...getProcessingOpts(),
      flatField: false, whiteBalance: false, stainNorm: false,
      clahe: false, sharpen: false, applyManual: true,
    };
    const src = entry.resultCanvas || entry.origCanvas;
    const { canvas: workCanvas, scale } = downscaleCanvas(src, MAX_PROCESS_PX);
    const { imgData } = await withTimeout(
      Pipeline.process(workCanvas, opts, (p, m) => setProgress(p, m)),
      PROCESS_TIMEOUT_MS
    );
    const small = document.createElement('canvas');
    small.width = imgData.width; small.height = imgData.height;
    small.getContext('2d').putImageData(imgData, 0, 0);
    const result = scale < 1 ? upscaleCanvas(small, src.width, src.height) : small;
    entry.resultCanvas = result;
    drawToCanvas(result, dom.canvasAfter);
    updateSliderCanvases();
    setStatus('Manuel ayarlar uygulandı', 'ok');
  } catch (err) {
    console.error('[app] applyManualOpts hatası:', err.stack || err);
    showError('Manuel ayar hatası: ' + err.message);
  } finally {
    showProcessing(false);
    setProcessingButtons(true);
  }
}

/* ── Toplu işleme ─────────────────────────────────────────── */
async function processAll() {
  for (let i = 0; i < state.files.length; i++) {
    activateImage(i);
    await processActive();
    await new Promise(r => setTimeout(r, 30)); // UI nefes alsın
  }
  setStatus(state.files.length + ' görüntü işlendi', 'ok');
}

/* ── Referans görüntü ─────────────────────────────────────── */
async function loadRef(file) {
  if (!state.openCVReady) { showError('OpenCV henüz hazır değil.'); return; }
  try {
    const canvas = await loadImageFile(file);
    const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const rgba = cv.matFromImageData(imgData);
    const bgr  = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    Pipeline.setCustomRef(bgr);
    rgba.delete(); bgr.delete();

    dom.refThumb.style.display = 'block';
    dom.refThumb.innerHTML = '';
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.7);
    dom.refThumb.appendChild(img);
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
    setStatus('Referans görüntü yüklendi', 'ok');
  } catch (err) {
    showError('Referans yüklenemedi: ' + err.message);
  }
}

/* ── Dışa aktarma ─────────────────────────────────────────── */
function getExportCanvas(entry) {
  const src  = entry.resultCanvas || entry.origCanvas;
  const reqW = parseInt($('exportWidth').value)  || src.width;
  const reqH = parseInt($('exportHeight').value) || src.height;
  if (reqW === src.width && reqH === src.height) return src;
  const out = document.createElement('canvas');
  out.width = reqW; out.height = reqH;
  out.getContext('2d').drawImage(src, 0, 0, reqW, reqH);
  return out;
}

function canvasToBlob(canvas, format, quality) {
  return new Promise(resolve => {
    if (format === 'tiff') {
      const id  = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const buf = UTIF.encodeImage(id.data, canvas.width, canvas.height);
      resolve(new Blob([buf], { type: 'image/tiff' }));
    } else {
      canvas.toBlob(resolve, 'image/' + format, quality / 100);
    }
  });
}

function baseName(fname) { return fname.replace(/\.[^/.]+$/, ''); }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportSingle() {
  if (state.activeIdx < 0) return;
  const entry   = state.files[state.activeIdx];
  const canvas  = getExportCanvas(entry);
  const format  = $('exportFormat').value;
  const quality = parseInt($('exportQuality').value);
  setStatus('Dışa aktarılıyor…');
  const blob = await canvasToBlob(canvas, format, quality);
  downloadBlob(blob, baseName(entry.name) + '.' + (format === 'jpeg' ? 'jpg' : format));
  setStatus('İndirildi: ' + entry.name, 'ok');
}

async function exportBatch() {
  if (state.files.length === 0) return;
  const format  = $('exportFormat').value;
  const quality = parseInt($('exportQuality').value);
  const zip     = new JSZip();
  showProcessing(true, 'ZIP hazırlanıyor…');
  try {
    for (let i = 0; i < state.files.length; i++) {
      const entry  = state.files[i];
      const canvas = getExportCanvas(entry);
      const blob   = await canvasToBlob(canvas, format, quality);
      const ext    = format === 'jpeg' ? 'jpg' : format;
      zip.file(baseName(entry.name) + '_processed.' + ext, blob);
      setProgress(Math.round((i + 1) / state.files.length * 90),
        (i + 1) + '/' + state.files.length + ' hazırlandı');
    }
    setProgress(95, 'ZIP sıkıştırılıyor…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, 'patogoru_batch.zip');
    setStatus('Toplu indirme tamamlandı', 'ok');
  } finally {
    showProcessing(false);
  }
}

/* ── Kaydırıcı senkronizasyonu ───────────────────────────── */
function syncSlider(inputId, valueId) {
  const input = $(inputId), span = $(valueId);
  if (!input || !span) return;
  input.addEventListener('input', () => { span.textContent = input.value; });
}

/* ── Olayları bağla ──────────────────────────────────────── */
function bindEvents() {
  // Hata kutusu kapat
  $('btnErrorClose').addEventListener('click', hideError);

  // Sürükle-bırak
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', e => addFiles(e.target.files));
  dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  // Görünüm
  document.querySelectorAll('.view-btn').forEach(btn =>
    btn.addEventListener('click', () => setViewMode(btn.dataset.view)));

  // Zoom
  $('btnZoomIn').addEventListener('click',  () => { state.zoom = Math.min(state.zoom * 1.25, 8); applyZoom(); });
  $('btnZoomOut').addEventListener('click', () => { state.zoom = Math.max(state.zoom / 1.25, 0.1); applyZoom(); });
  $('btnZoomFit').addEventListener('click', () => { state.zoom = 1.0; applyZoom(); });

  // İşleme
  dom.btnAutoProcess.addEventListener('click',  processActive);
  dom.btnApplyManual.addEventListener('click',  applyManualOpts);
  dom.btnBatchProcess.addEventListener('click', processAll);

  // Sıfırla
  $('btnResetManual').addEventListener('click', () => {
    ['sBrightness','sContrast','sSaturation','sTemperature'].forEach(id => $(id).value = 0);
    ['sHema','sEosin','sDAB'].forEach(id => $(id).value = 100);
    $('sSharpen').value   = 0;
    $('sFlatField').value = 50;
    document.querySelectorAll('.slider-val').forEach(s => {
      const inp = s.previousElementSibling;
      if (inp && inp.type === 'range') s.textContent = inp.value;
    });
  });

  // Dışa aktar
  $('btnExportSingle').addEventListener('click', exportSingle);
  $('btnExportBatch').addEventListener('click',  exportBatch);
  $('exportFormat').addEventListener('change', e => {
    dom.jpgQualityRow.style.display = e.target.value === 'jpeg' ? '' : 'none';
  });

  // Referans (opsiyonel)
  $('btnLoadRef').addEventListener('click', () => dom.refInput.click());
  dom.refInput.addEventListener('change', e => { if (e.target.files[0]) loadRef(e.target.files[0]); });

  // Hazır presetler
  document.querySelectorAll('.btn-preset').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Pipeline.setPreset(btn.dataset.preset);
      setStatus('Referans: ' + btn.textContent, 'ok');
    }));

  // Boya tipi radyo
  document.querySelectorAll('input[name="stain"]').forEach(radio =>
    radio.addEventListener('change', () => {
      document.querySelectorAll('.radio-btn').forEach(lbl =>
        lbl.classList.toggle('active', lbl.querySelector('input') === radio));
    }));

  // Slider (önce/sonra)
  initSliderDrag();

  // Kaydırıcı senkronizasyonu
  [['sBrightness','vBrightness'],['sContrast','vContrast'],
   ['sSaturation','vSaturation'],['sTemperature','vTemperature'],
   ['sHema','vHema'],['sEosin','vEosin'],['sDAB','vDAB'],
   ['sSharpen','vSharpen'],['sFlatField','vFlatField'],
   ['exportQuality','vExportQuality']
  ].forEach(([i, v]) => syncSlider(i, v));

  // Manuel bölüm daralt/genişlet
  $('btnCollapseManual').addEventListener('click', () => {
    const sl  = $('manualSliders');
    const btn = $('btnCollapseManual');
    const collapsed = sl.style.display === 'none';
    sl.style.display    = collapsed ? '' : 'none';
    btn.textContent = collapsed ? '▾' : '▸';
  });

  // En/boy kilidi
  $('exportWidth').addEventListener('input', () => {
    if (!$('chkLockAspect').checked || state.activeIdx < 0) return;
    const src = state.files[state.activeIdx].resultCanvas || state.files[state.activeIdx].origCanvas;
    const w   = parseInt($('exportWidth').value);
    if (w) $('exportHeight').value = Math.round(w * src.height / src.width);
  });
  $('exportHeight').addEventListener('input', () => {
    if (!$('chkLockAspect').checked || state.activeIdx < 0) return;
    const src = state.files[state.activeIdx].resultCanvas || state.files[state.activeIdx].origCanvas;
    const h   = parseInt($('exportHeight').value);
    if (h) $('exportWidth').value = Math.round(h * src.width / src.height);
  });
}

/* ── Başlangıç ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initDom();
  bindEvents();
  initOpenCV();
});
