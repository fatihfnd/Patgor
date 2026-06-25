'use strict';

/* ══════════════════════════════════════════════════════════════
   Patgor — Main application controller
   ══════════════════════════════════════════════════════════════ */

/* ── State ──────────────────────────────────────────────────── */
const state = {
  cvReady:        false,
  images:         [],    // [{file, img, srcMat, correctedMat, canvas, correctedCanvas, name}]
  activeIdx:      -1,
  refMat:         null,
  refStats:       null,
  compareMode:    'side-by-side',  // 'side-by-side' | 'slider'
  sliderX:        0.5,             // 0–1 for the slider
};

/* ── DOM refs ───────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const dom = {
  cvStatus:          $('cv-status'),
  dropZone:          $('drop-zone'),
  fileInput:         $('file-input'),
  batchPanel:        $('batch-panel'),
  batchCount:        $('batch-count'),
  batchList:         $('batch-list'),
  btnClearBatch:     $('btn-clear-batch'),

  refPreset:         $('ref-preset'),
  customRefRow:      $('custom-ref-row'),
  refFileInput:      $('ref-file-input'),
  btnPickRef:        $('btn-pick-ref'),
  refName:           $('ref-name'),

  stainDetected:     $('stain-detected'),
  stainDetectedVal:  $('stain-detected-val'),

  exportFormat:      $('export-format'),
  jpgQualityRow:     $('jpg-quality-row'),
  jpgQuality:        $('jpg-quality'),
  jpgQualityVal:     $('jpg-quality-val'),
  exportDpi:         $('export-dpi'),
  exportSize:        $('export-size'),
  customSizeRow:     $('custom-size-row'),
  exportCustomW:     $('export-custom-w'),
  btnExportSingle:   $('btn-export-single'),
  btnExportBatch:    $('btn-export-batch'),

  emptyState:        $('empty-state'),
  viewer:            $('viewer'),
  imgName:           $('img-name'),
  imgSizeLabel:      $('img-size'),

  btnSideBySide:     $('btn-side-by-side'),
  btnSlider:         $('btn-slider'),

  viewSideBySide:    $('view-side-by-side'),
  viewSlider:        $('view-slider'),
  canvasBefore:      $('canvas-before'),
  canvasAfter:       $('canvas-after'),
  canvasSliderBefore:$('canvas-slider-before'),
  canvasSliderAfter: $('canvas-slider-after'),
  sliderDivider:     $('slider-divider'),

  btnAutoCorrect:    $('btn-auto-correct'),
  btnReset:          $('btn-reset'),
  processingOverlay: $('processing-overlay'),
  processingMsg:     $('processing-msg'),
  processingStep:    $('processing-step'),

  // Manual sliders
  slTemp:            $('sl-temp'),
  slBrightness:      $('sl-brightness'),
  slContrast:        $('sl-contrast'),
  slSaturation:      $('sl-saturation'),
  slHema:            $('sl-hema'),
  slEosin:           $('sl-eosin'),
  slDab:             $('sl-dab'),
  slSharpness:       $('sl-sharpness'),
  slFlatField:       $('sl-flatfield'),
  btnApplyManual:    $('btn-apply-manual'),
  btnResetSliders:   $('btn-reset-sliders'),

  pipelineStatusSection: $('pipeline-status-section'),
  pipelineSteps:         $('pipeline-steps'),
};

/* ── OpenCV ready callbacks ─────────────────────────────────── */
function onOpenCvReady() {
  state.cvReady = true;
  dom.cvStatus.textContent = 'OpenCV hazır';
  dom.cvStatus.className = 'cv-status ready';
  if (state.activeIdx >= 0) enableControls();
}

function onOpenCvError() {
  dom.cvStatus.textContent = 'OpenCV yüklenemedi';
  dom.cvStatus.className = 'cv-status error';
  console.error('OpenCV.js yüklenemedi');
}

/* ── File input & drag-drop ─────────────────────────────────── */
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') dom.fileInput.click(); });
dom.fileInput.addEventListener('change', e => handleFiles(Array.from(e.target.files)));

dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('dragover'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
dom.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dom.dropZone.classList.remove('dragover');
  handleFiles(Array.from(e.dataTransfer.files));
});

dom.btnClearBatch.addEventListener('click', () => {
  // Free mats
  for (const item of state.images) { safeDelete(item.srcMat); safeDelete(item.correctedMat); }
  state.images = [];
  state.activeIdx = -1;
  renderBatchList();
  showEmptyState();
});

async function handleFiles(files) {
  const allowed = files.filter(f => /\.(jpe?g|png|tiff?)$/i.test(f.name));
  if (!allowed.length) return;

  for (const file of allowed) {
    // Check if already in list
    if (state.images.some(i => i.name === file.name && i.file.size === file.size)) continue;
    state.images.push({ file, name: file.name, img: null, srcMat: null, correctedMat: null });
  }

  renderBatchList();

  // Load images
  for (let idx = 0; idx < state.images.length; idx++) {
    const item = state.images[idx];
    if (item.img) continue;
    setBatchItemStatus(idx, 'active');
    try {
      const { img } = await loadImageFile(item.file);
      item.img = img;
    } catch(e) {
      console.error('Görüntü yüklenemedi:', item.name, e);
      setBatchItemStatus(idx, 'error');
    }
    setBatchItemStatus(idx, item.img ? 'pending' : 'error');
  }

  // Activate first valid
  const firstValid = state.images.findIndex(i => i.img);
  if (firstValid >= 0) activateImage(firstValid);
}

function activateImage(idx) {
  state.activeIdx = idx;
  const item = state.images[idx];

  // Highlight in batch list
  renderBatchList();

  // Show viewer
  dom.emptyState.classList.add('hidden');
  dom.viewer.classList.remove('hidden');

  dom.imgName.textContent = item.name;
  dom.imgSizeLabel.textContent = `${item.img.naturalWidth || item.img.width} × ${item.img.naturalHeight || item.img.height} px`;

  // Render "before" canvas from img
  renderBeforeCanvas(item);

  // Clear "after" canvas (if no correction yet)
  if (!item.correctedMat) {
    clearCanvas(dom.canvasAfter);
    clearCanvas(dom.canvasSliderAfter);
  } else {
    renderAfterCanvas(item);
  }

  if (state.cvReady) enableControls();
}

/* ── Batch list render ──────────────────────────────────────── */
function renderBatchList() {
  const n = state.images.length;
  if (n === 0) { dom.batchPanel.classList.add('hidden'); return; }
  dom.batchPanel.classList.remove('hidden');
  dom.batchCount.textContent = `${n} görüntü`;

  dom.batchList.innerHTML = '';
  state.images.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'batch-item' + (idx === state.activeIdx ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'bi-status ' + (item._status || 'pending');

    const name = document.createElement('span');
    name.className = 'bi-name';
    name.textContent = item.name;
    name.title = item.name;

    li.append(dot, name);
    li.addEventListener('click', () => activateImage(idx));
    dom.batchList.appendChild(li);
  });

  // Show/hide batch export
  dom.btnExportBatch.classList.toggle('hidden', n <= 1);
}

function setBatchItemStatus(idx, status) {
  if (state.images[idx]) state.images[idx]._status = status;
  const li = dom.batchList.querySelectorAll('.batch-item')[idx];
  if (li) {
    const dot = li.querySelector('.bi-status');
    if (dot) { dot.className = 'bi-status ' + status; }
  }
}

/* ── Canvas rendering ───────────────────────────────────────── */
function renderBeforeCanvas(item) {
  const img = item.img;
  // Draw into the display canvases
  _drawImgToCanvas(img, dom.canvasBefore);
  _drawImgToCanvas(img, dom.canvasSliderBefore);
}

function renderAfterCanvas(item) {
  if (!item.correctedMat) return;
  matToCanvas(item.correctedMat, dom.canvasAfter);
  matToCanvas(item.correctedMat, dom.canvasSliderAfter);
  // Update slider clip
  updateSliderClip(state.sliderX);
}

function _drawImgToCanvas(img, canvas) {
  canvas.width  = img.naturalWidth  || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/* ── Controls enable/disable ────────────────────────────────── */
function enableControls() {
  dom.btnAutoCorrect.disabled = false;
  dom.btnReset.disabled = false;
  dom.btnApplyManual.disabled = false;
  dom.btnExportSingle.disabled = false;
  if (state.images.length > 1) dom.btnExportBatch.disabled = false;
}

function disableControls() {
  dom.btnAutoCorrect.disabled = true;
  dom.btnReset.disabled = true;
  dom.btnApplyManual.disabled = true;
  dom.btnExportSingle.disabled = true;
  dom.btnExportBatch.disabled = true;
}

function showEmptyState() {
  dom.viewer.classList.add('hidden');
  dom.emptyState.classList.remove('hidden');
  disableControls();
}

/* ── Compare mode toggle ────────────────────────────────────── */
dom.btnSideBySide.addEventListener('click', () => setCompareMode('side-by-side'));
dom.btnSlider.addEventListener('click',     () => setCompareMode('slider'));

function setCompareMode(mode) {
  state.compareMode = mode;
  dom.btnSideBySide.classList.toggle('active', mode === 'side-by-side');
  dom.btnSlider.classList.toggle('active',     mode === 'slider');
  dom.viewSideBySide.classList.toggle('hidden', mode !== 'side-by-side');
  dom.viewSlider.classList.toggle('hidden',     mode !== 'slider');
}

/* ── Slider drag ────────────────────────────────────────────── */
(function setupSlider() {
  let dragging = false;
  const container = dom.viewSlider.querySelector('.slider-container');

  function onMove(e) {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    state.sliderX = x;
    updateSliderClip(x);
  }

  container.addEventListener('mousedown',  e => { dragging = true; onMove(e); });
  container.addEventListener('touchstart', e => { dragging = true; onMove(e); }, { passive: true });
  window.addEventListener('mouseup',   () => { dragging = false; });
  window.addEventListener('touchend',  () => { dragging = false; });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: true });
})();

function updateSliderClip(x) {
  const pct = (x * 100).toFixed(1);
  dom.canvasSliderAfter.style.clipPath = `polygon(${pct}% 0, 100% 0, 100% 100%, ${pct}% 100%)`;
  dom.sliderDivider.style.left = pct + '%';
}

/* ── Reference preset / custom ref ─────────────────────────── */
dom.refPreset.addEventListener('change', () => {
  const isCustom = dom.refPreset.value === 'custom';
  dom.customRefRow.classList.toggle('hidden', !isCustom);
  if (!isCustom) { state.refStats = null; }
});

dom.btnPickRef.addEventListener('click', () => dom.refFileInput.click());
dom.refFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { img } = await loadImageFile(file);
    dom.refName.textContent = file.name;
    if (!state.cvReady) { alert('OpenCV henüz hazır değil'); return; }
    const mat = imageToBGRMat(img);
    state.refStats = computeLabStats(mat);
    mat.delete();
  } catch(err) {
    console.error('Referans yüklenemedi:', err);
    alert('Referans görüntü yüklenemedi: ' + err.message);
  }
});

/* ── Auto correction ────────────────────────────────────────── */
dom.btnAutoCorrect.addEventListener('click', () => {
  if (state.activeIdx < 0 || !state.cvReady) return;
  runCorrection(state.activeIdx);
});

async function runCorrection(idx) {
  const item = state.images[idx];
  if (!item.img) return;

  showProcessing('Düzeltme başlatılıyor…', '');
  disableControls();

  try {
    // Build srcMat from img
    if (!item.srcMat) {
      item.srcMat = imageToBGRMat(item.img);
    }

    const stainRadio = document.querySelector('input[name="stain"]:checked');
    const stainMode = stainRadio ? stainRadio.value : 'auto';
    const refPreset = dom.refPreset.value;
    const refStats  = state.refStats;

    const flatFieldStrength = parseInt(dom.slFlatField.value, 10);

    const { mat, stainType, steps } = await runAutoPipeline(item.srcMat, {
      stainMode,
      refPreset,
      refStats,
      flatFieldStrength,
      onStep: (name, done) => {
        const labels = {
          'flat-field':    'Işık eğimi düzeltme',
          'white-balance': 'Beyaz dengesi',
          'stain-detect':  'Boya algılama',
          'stain-norm':    'Boya normalizasyonu',
          'clahe':         'CLAHE kontrast',
          'sharpen':       'Keskinlik',
        };
        updateProcessingStep(labels[name] || name, done);
      }
    });

    // Free old corrected mat
    safeDelete(item.correctedMat);
    item.correctedMat = mat;
    item._status = 'done';
    setBatchItemStatus(idx, 'done');

    // Show detected stain
    dom.stainDetectedVal.textContent = stainType.toUpperCase();
    dom.stainDetected.classList.remove('hidden');

    // Render
    renderAfterCanvas(item);
    renderPipelineSteps(steps);

    // Sync slider value from manual sliders to 0 (correction applied)
    // (manual sliders remain at last position; user can apply on top)
  } catch(err) {
    console.error('Pipeline hatası:', err);
    item._status = 'error';
    setBatchItemStatus(idx, 'error');
    alert('Düzeltme sırasında hata: ' + err.message);
  }

  hideProcessing();
  if (state.cvReady) enableControls();
}

/* ── Reset ──────────────────────────────────────────────────── */
dom.btnReset.addEventListener('click', () => {
  if (state.activeIdx < 0) return;
  const item = state.images[state.activeIdx];
  safeDelete(item.correctedMat);
  item.correctedMat = null;
  item._status = 'pending';
  setBatchItemStatus(state.activeIdx, 'pending');
  clearCanvas(dom.canvasAfter);
  clearCanvas(dom.canvasSliderAfter);
  dom.stainDetected.classList.add('hidden');
  dom.pipelineStatusSection.style.display = 'none';
});

/* ── Manual adjustments ─────────────────────────────────────── */
// Live value display for all sliders
const sliderPairs = [
  ['sl-temp', 'sl-temp-val'],
  ['sl-brightness', 'sl-brightness-val'],
  ['sl-contrast', 'sl-contrast-val'],
  ['sl-saturation', 'sl-saturation-val'],
  ['sl-hema', 'sl-hema-val'],
  ['sl-eosin', 'sl-eosin-val'],
  ['sl-dab', 'sl-dab-val'],
  ['sl-sharpness', 'sl-sharpness-val'],
  ['sl-flatfield', 'sl-flatfield-val'],
  ['jpg-quality', 'jpg-quality-val'],
];
for (const [slId, valId] of sliderPairs) {
  const sl  = $(slId);
  const val = $(valId);
  if (sl && val) {
    sl.addEventListener('input', () => { val.textContent = sl.value; });
  }
}

dom.btnApplyManual.addEventListener('click', () => {
  if (state.activeIdx < 0 || !state.cvReady) return;
  applyManual(state.activeIdx);
});

dom.btnResetSliders.addEventListener('click', () => {
  const defaults = { 'sl-temp':0,'sl-brightness':0,'sl-contrast':0,'sl-saturation':0,
    'sl-hema':0,'sl-eosin':0,'sl-dab':0,'sl-sharpness':0,'sl-flatfield':80 };
  for (const [id, val] of Object.entries(defaults)) {
    const el = $(id); if (el) el.value = val;
    const vEl = $(id + '-val'); if (vEl) vEl.textContent = val;
  }
});

async function applyManual(idx) {
  const item = state.images[idx];
  if (!item.img) return;

  // Use corrected mat as base if available, else src
  if (!item.srcMat) item.srcMat = imageToBGRMat(item.img);
  const base = item.correctedMat || item.srcMat;

  showProcessing('Manuel ayarlar uygulanıyor…', '');
  disableControls();

  try {
    await tick();
    const params = {
      temperature:  parseInt(dom.slTemp.value, 10),
      brightness:   parseInt(dom.slBrightness.value, 10),
      contrast:     parseInt(dom.slContrast.value, 10),
      saturation:   parseInt(dom.slSaturation.value, 10),
      hema:         parseInt(dom.slHema.value, 10),
      eosin:        parseInt(dom.slEosin.value, 10),
      dab:          parseInt(dom.slDab.value, 10),
      sharpness:    parseInt(dom.slSharpness.value, 10),
      flatField:    parseInt(dom.slFlatField.value, 10),
    };

    const adjusted = applyManualAdjustments(base, params);
    safeDelete(item.correctedMat);
    item.correctedMat = adjusted;
    renderAfterCanvas(item);
  } catch(err) {
    console.error('Manuel ayar hatası:', err);
    alert('Manuel ayar hatası: ' + err.message);
  }

  hideProcessing();
  if (state.cvReady) enableControls();
}

/* ── Export ─────────────────────────────────────────────────── */
dom.exportFormat.addEventListener('change', () => {
  dom.jpgQualityRow.classList.toggle('hidden', dom.exportFormat.value !== 'jpeg');
});

dom.exportSize.addEventListener('change', () => {
  dom.customSizeRow.classList.toggle('hidden', dom.exportSize.value !== 'custom');
});

function getExportOpts() {
  const format  = dom.exportFormat.value;
  const quality = parseInt(dom.jpgQuality.value, 10) / 100;
  const dpi     = parseInt(dom.exportDpi.value, 10);
  let maxDim = 0;
  if (dom.exportSize.value === 'custom') {
    maxDim = parseInt(dom.exportCustomW.value, 10) || 0;
  } else if (dom.exportSize.value !== 'original') {
    maxDim = parseInt(dom.exportSize.value, 10);
  }
  return { format, quality, dpi, maxDim };
}

dom.btnExportSingle.addEventListener('click', async () => {
  if (state.activeIdx < 0) return;
  const item = state.images[state.activeIdx];
  const canvas = item.correctedMat
    ? (() => { const c = document.createElement('canvas'); matToCanvas(item.correctedMat, c); return c; })()
    : dom.canvasBefore;

  dom.btnExportSingle.disabled = true;
  try {
    const blob = await exportCanvas(canvas, getExportOpts());
    const ext  = getExportOpts().format === 'png' ? 'png' : getExportOpts().format === 'tiff' ? 'tif' : 'jpg';
    saveAs(blob, item.name.replace(/\.[^.]+$/, '') + '_duzeltilmis.' + ext);
  } catch(err) {
    alert('Dışa aktarma hatası: ' + err.message);
  }
  dom.btnExportSingle.disabled = false;
});

dom.btnExportBatch.addEventListener('click', async () => {
  const corrected = state.images
    .filter(i => i.correctedMat)
    .map(i => {
      const c = document.createElement('canvas');
      matToCanvas(i.correctedMat, c);
      return { canvas: c, name: i.name };
    });

  if (!corrected.length) { alert('Henüz düzeltilmiş görüntü yok.'); return; }

  dom.btnExportBatch.disabled = true;
  try {
    const blob = await exportBatchAsZip(corrected, getExportOpts());
    saveAs(blob, 'patgor_duzeltilmis.zip');
  } catch(err) {
    alert('Toplu dışa aktarma hatası: ' + err.message);
  }
  dom.btnExportBatch.disabled = false;
});

/* ── Processing overlay ─────────────────────────────────────── */
function showProcessing(msg, step) {
  dom.processingMsg.textContent  = msg;
  dom.processingStep.textContent = step;
  dom.processingOverlay.classList.remove('hidden');
}
function updateProcessingStep(stepName, done) {
  dom.processingStep.textContent = (done ? '✓ ' : '… ') + stepName;
}
function hideProcessing() {
  dom.processingOverlay.classList.add('hidden');
}

/* ── Pipeline steps display ─────────────────────────────────── */
function renderPipelineSteps(steps) {
  dom.pipelineStatusSection.style.display = '';
  dom.pipelineSteps.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = 'pipeline-step ' + (step.status || 'done');
    const icon = step.status === 'done' ? '✓' : step.status === 'skip' ? '–' : '✗';
    li.innerHTML = `<span class="step-icon">${icon}</span>${step.name}`;
    dom.pipelineSteps.appendChild(li);
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */
function safeDelete(mat) { try { if (mat && !mat.isDeleted()) mat.delete(); } catch(e) {} }

function tick() { return new Promise(r => setTimeout(r, 0)); }
