/**
 * collage.js — Kolaj / Figür Düzenleyici
 *
 * Panel modeli — önizleme boyutundan bağımsız:
 *   zoomFactor : 1.0 = fit-inside, 2.0 = 2× büyütme
 *   panFracX/Y : kaydırma, CANVAS genişliği/yüksekliğinin kesri cinsinden
 *                (0,0) = ortalanmış (default)
 *
 * Bu sayede exportW/exportH ya da cols/rows değişince görüntü kayması/
 * küçülmesi olmaz — her zaman doğru kadraj export edilir.
 */
'use strict';

const Collage = (() => {

  /* ── Sabitler ──────────────────────────────────────────────── */
  const MIN_CELL_PX = 80;
  const ASPECT_PRESETS = {
    '1:1':  [1, 1],
    '4:3':  [4, 3],
    '3:2':  [3, 2],
    '16:9': [16, 9],
    'free': null,
  };

  /* ── Durum ────────────────────────────────────────────────── */
  const panels = [];   // panel | null;  panel = {canvas,previewSrc,zoomFactor,panFracX,panFracY}
  const cfg = {
    cols: 2, rows: 2, gapH: 8, gapV: 8, lockGap: true,
    bg: '#ffffff',
    labelStyle: 'upper', labelPos: 'tl',
    labelSize: 64, labelColor: '#ffffff', labelBg: true,
    exportW: 1000, exportH: 1000,
    aspect: '1:1',
  };

  let dragSrcIdx = null;
  let panOp      = null;   // aktif fare sürükleme

  /* ── DOM ──────────────────────────────────────────────────── */
  const $c = id => document.getElementById(id);
  let dom = {};

  function initDom() {
    dom = {
      grid:       $c('cgGrid'),
      gridWrap:   $c('cgGridWrap'),
      drop:       $c('cgDropZone'),
      fileInput:  $c('cgFileInput'),
      cols:       $c('cgCols'),
      rows:       $c('cgRows'),
      gapH:       $c('cgGapH'),
      gapV:       $c('cgGapV'),
      lockGap:    $c('cgLockGap'),
      bg:         $c('cgBg'),
      lstyle:     $c('cgLabelStyle'),
      lpos:       $c('cgLabelPos'),
      lsize:      $c('cgLabelSize'),
      lcolor:     $c('cgLabelColor'),
      lbg:        $c('cgLabelBg'),
      aspect:     $c('cgAspect'),
      exportW:    $c('cgExportW'),
      exportH:    $c('cgExportH'),
      exportHRow: $c('cgExportHRow'),
      exportFmt:  $c('cgExportFmt'),
      exportQ:    $c('cgExportQ'),
      exportQRow: $c('cgExportQRow'),
      btnExport:  $c('btnCgExport'),
      btnAddAll:  $c('btnCgAddAll'),
      btnClear:   $c('btnCgClear'),
    };
  }

  /* ── Yardımcı ─────────────────────────────────────────────── */
  function getLabel(idx) {
    if (cfg.labelStyle === 'upper') return String.fromCharCode(65 + idx);
    if (cfg.labelStyle === 'lower') return String.fromCharCode(97 + idx);
    if (cfg.labelStyle === 'num')   return String(idx + 1);
    return '';
  }

  // Önizleme hücre boyutu (piksel)
  function cellSize() {
    const aw = Math.max(320, (dom.gridWrap?.clientWidth || 720) - 4);
    const w  = Math.max(MIN_CELL_PX,
      Math.floor((aw - cfg.gapH * (cfg.cols - 1)) / cfg.cols));
    const h  = Math.round(w * cfg.exportH / cfg.exportW);
    return { w, h };
  }

  // Canvas'ı cw×ch hücreye sığdıran "fit-inside" ölçek
  function fitInside(canvas, cw, ch) {
    return Math.min(cw / canvas.width, ch / canvas.height);
  }

  // Panel için her zaman taze ölçek ve offset hesapla
  function panelTransform(panel, cw, ch) {
    const fit = fitInside(panel.canvas, cw, ch);
    const sc  = fit * panel.zoomFactor;
    const offX = (cw - panel.canvas.width  * sc) / 2
               + panel.panFracX * panel.canvas.width  * sc;
    const offY = (ch - panel.canvas.height * sc) / 2
               + panel.panFracY * panel.canvas.height * sc;
    return { sc, offX, offY };
  }

  function labelPosCSS(pos) {
    return {
      tl: 'top:6px;left:6px',
      tr: 'top:6px;right:6px',
      bl: 'bottom:6px;left:6px',
      br: 'bottom:6px;right:6px',
    }[pos] || 'top:6px;left:6px';
  }

  /* ── Izgara oluşturma ─────────────────────────────────────── */
  function renderGrid() {
    if (!dom.grid) return;
    const { w, h } = cellSize();
    const g = dom.grid;
    g.innerHTML = '';
    g.style.cssText = [
      'display:inline-grid',
      `grid-template-columns:repeat(${cfg.cols},${w}px)`,
      `grid-template-rows:repeat(${cfg.rows},${h}px)`,
      `gap:${cfg.gapV}px ${cfg.gapH}px`,
      `background:${cfg.bg === 'transparent' ? '#2a2a2a' : cfg.bg}`,
      'padding:0;box-sizing:content-box',
    ].join(';');
    const n = cfg.rows * cfg.cols;
    for (let i = 0; i < n; i++) buildCell(i, w, h);
  }

  function buildCell(idx, w, h) {
    const panel = panels[idx] || null;
    const div   = document.createElement('div');
    div.className   = 'cg-cell';
    div.dataset.idx = idx;
    div.style.cssText = `width:${w}px;height:${h}px;position:relative;`
      + `overflow:hidden;background:${cfg.bg === 'transparent' ? '#1a2030' : cfg.bg};`
      + 'box-sizing:border-box;';

    div.addEventListener('dragover',  e => { e.preventDefault(); div.classList.add('cg-drop-over'); });
    div.addEventListener('dragleave', ()  => div.classList.remove('cg-drop-over'));
    div.addEventListener('drop',      e  => onCellDrop(e, idx));

    if (panel?.canvas) {
      const img = document.createElement('img');
      img.draggable = false;
      img.src = panel.previewSrc ||
        (panel.previewSrc = panel.canvas.toDataURL('image/jpeg', 0.72));
      img.style.cssText = 'position:absolute;transform-origin:0 0;'
        + 'user-select:none;-webkit-user-select:none;pointer-events:none;';

      const { sc, offX, offY } = panelTransform(panel, w, h);
      img.style.transform = `translate(${offX}px,${offY}px) scale(${sc})`;
      div.appendChild(img);

      div.addEventListener('mousedown', e => startPan(e, idx, img, w, h));
      div.addEventListener('wheel', e => {
        e.preventDefault();
        handleZoom(e, idx, img, w, h);
      }, { passive: false });

      // Etiket
      const ltext = getLabel(idx);
      if (ltext) {
        const pxFont = Math.max(8, Math.round(cfg.labelSize * w / Math.max(1, cfg.exportW)));
        const lb = document.createElement('div');
        lb.className = 'cg-label';
        lb.textContent = ltext;
        const shadow = cfg.labelBg
          ? 'background:rgba(0,0,0,0.45);padding:1px 5px;border-radius:3px;'
          : 'text-shadow:0 0 4px rgba(0,0,0,0.9),0 0 2px #000;';
        lb.style.cssText = `position:absolute;z-index:6;font-size:${pxFont}px;font-weight:bold;`
          + `color:${cfg.labelColor};${shadow}${labelPosCSS(cfg.lpos)};pointer-events:none;`;
        div.appendChild(lb);
      }

      const handle = document.createElement('div');
      handle.className   = 'cg-handle';
      handle.draggable   = true;
      handle.title       = 'Sürükle (yer değiştir)';
      handle.textContent = '⠿';
      handle.addEventListener('mousedown', e => e.stopPropagation());
      handle.addEventListener('dragstart', e => onHandleDragStart(e, idx));
      div.appendChild(handle);

      const del = document.createElement('button');
      del.className   = 'cg-del';
      del.title       = 'Paneli kaldır';
      del.textContent = '×';
      del.addEventListener('mousedown', e => e.stopPropagation());
      del.addEventListener('click', () => { panels[idx] = null; renderGrid(); });
      div.appendChild(del);

    } else {
      const empty = document.createElement('div');
      empty.className = 'cg-empty';
      empty.innerHTML = '＋<br><small>Yükle</small>';
      empty.addEventListener('click', () => pickFileForCell(idx));
      div.appendChild(empty);
    }

    dom.grid.appendChild(div);
  }

  /* ── Pan ──────────────────────────────────────────────────── */
  function startPan(e, idx, img, cw, ch) {
    if (e.button !== 0) return;
    const p = panels[idx];
    panOp = {
      idx, img, cw, ch,
      startPanFracX: p.panFracX,
      startPanFracY: p.panFracY,
      sx: e.clientX, sy: e.clientY,
    };
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup',   onPanUp);
    e.preventDefault();
  }

  function onPanMove(e) {
    if (!panOp) return;
    const p  = panels[panOp.idx];
    const { sc } = panelTransform(p, panOp.cw, panOp.ch);
    const dx = (e.clientX - panOp.sx) / (p.canvas.width  * sc);
    const dy = (e.clientY - panOp.sy) / (p.canvas.height * sc);
    p.panFracX = panOp.startPanFracX + dx;
    p.panFracY = panOp.startPanFracY + dy;
    const { offX, offY } = panelTransform(p, panOp.cw, panOp.ch);
    panOp.img.style.transform = `translate(${offX}px,${offY}px) scale(${sc})`;
  }

  function onPanUp() {
    panOp = null;
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup',   onPanUp);
  }

  /* ── Zoom ─────────────────────────────────────────────────── */
  function handleZoom(e, idx, img, cw, ch) {
    const p     = panels[idx];
    const rect  = img.closest('.cg-cell').getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 1.13 : 1 / 1.13;

    const { sc: oldSc, offX: oldOffX, offY: oldOffY } = panelTransform(p, cw, ch);
    const newZoom = Math.max(0.05, Math.min(20, p.zoomFactor * delta));
    p.zoomFactor  = newZoom;

    // Odak noktasını koru: zoom öncesi ve sonrası fare altındaki canvas pikseli aynı kalsın
    const newSc   = fitInside(p.canvas, cw, ch) * newZoom;
    const ratioSc = newSc / oldSc;
    // Yeni offX = mx - ratioSc*(mx - oldOffX), fraca çevir
    const newOffX = mx - ratioSc * (mx - oldOffX);
    const newOffY = my - ratioSc * (my - oldOffY);
    // panFrac geri hesapla
    const centX = (cw - p.canvas.width  * newSc) / 2;
    const centY = (ch - p.canvas.height * newSc) / 2;
    p.panFracX = (newOffX - centX) / (p.canvas.width  * newSc);
    p.panFracY = (newOffY - centY) / (p.canvas.height * newSc);

    img.style.transform = `translate(${newOffX}px,${newOffY}px) scale(${newSc})`;
  }

  /* ── Sırala (drag-to-reorder) ────────────────────────────── */
  function onHandleDragStart(e, idx) {
    dragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }

  function onCellDrop(e, tgtIdx) {
    e.preventDefault();
    dom.grid?.querySelectorAll('.cg-drop-over').forEach(el =>
      el.classList.remove('cg-drop-over'));
    if (dragSrcIdx === null || dragSrcIdx === tgtIdx) { dragSrcIdx = null; return; }
    const tmp = panels[dragSrcIdx];
    panels[dragSrcIdx] = panels[tgtIdx];
    panels[tgtIdx]     = tmp;
    dragSrcIdx = null;
    renderGrid();
  }

  /* ── Dosya yükleme ────────────────────────────────────────── */
  async function loadCanvasFromFile(file) {
    return new Promise((resolve, reject) => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (['tif', 'tiff'].includes(ext)) {
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const buf  = ev.target.result;
            const ifds = UTIF.decode(buf);
            UTIF.decodeImage(buf, ifds[0]);
            const rgba = UTIF.toRGBA8(ifds[0]);
            const w = ifds[0].width, h = ifds[0].height;
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').putImageData(
              new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
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
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Yüklenemedi')); };
        img.src = url;
      }
    });
  }

  function makePanel(canvas) {
    return { canvas, previewSrc: null, zoomFactor: 1.0, panFracX: 0, panFracY: 0 };
  }

  function pickFileForCell(idx) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.jpg,.jpeg,.png,.tif,.tiff';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      try {
        panels[idx] = makePanel(await loadCanvasFromFile(inp.files[0]));
        renderGrid();
      } catch (e) { console.error('[collage] hücre yükleme hatası:', e); }
    };
    inp.click();
  }

  /* ── Drop-zone ────────────────────────────────────────────── */
  function bindDropZone() {
    const dz = dom.drop;
    if (!dz) return;
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('cg-dz-over'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('cg-dz-over'));
    dz.addEventListener('drop', async e => {
      e.preventDefault();
      dz.classList.remove('cg-dz-over');
      for (const f of [...e.dataTransfer.files].filter(f =>
          /\.(jpg|jpeg|png|tif|tiff)$/i.test(f.name))) {
        try { panels.push(makePanel(await loadCanvasFromFile(f))); } catch (_) {}
      }
      renderGrid();
    });
    dz.addEventListener('click', () => dom.fileInput?.click());
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', async e => {
        for (const f of e.target.files) {
          try { panels.push(makePanel(await loadCanvasFromFile(f))); } catch (_) {}
        }
        renderGrid();
        dom.fileInput.value = '';
      });
    }
  }

  /* ── Editörden ekle ───────────────────────────────────────── */
  function addFromEditor() {
    if (typeof state === 'undefined' || !state.files) return;
    state.files.forEach(e => {
      const c = e.resultCanvas || e.origCanvas;
      if (c) panels.push(makePanel(c));
    });
    renderGrid();
  }

  /* ── Kontrolleri oku ─────────────────────────────────────── */
  function readCfg() {
    cfg.cols   = Math.max(1, parseInt(dom.cols?.value)   || 2);
    cfg.rows   = Math.max(1, parseInt(dom.rows?.value)   || 2);
    cfg.gapH   = Math.max(0, parseInt(dom.gapH?.value)   || 0);
    cfg.gapV   = dom.lockGap?.checked
      ? cfg.gapH
      : Math.max(0, parseInt(dom.gapV?.value) || 0);
    cfg.bg     = dom.bg?.value     || '#ffffff';
    cfg.labelStyle = dom.lstyle?.value || 'upper';
    cfg.lpos   = dom.lpos?.value   || 'tl';
    cfg.lsize  = Math.max(8, parseInt(dom.lsize?.value)  || 64);
    cfg.labelColor = dom.lcolor?.value || '#ffffff';
    cfg.labelBg    = dom.lbg?.checked !== false;
    cfg.aspect = dom.aspect?.value || '1:1';
    cfg.exportW = Math.max(64, parseInt(dom.exportW?.value) || 1000);

    const preset = ASPECT_PRESETS[cfg.aspect];
    if (preset) {
      cfg.exportH = Math.round(cfg.exportW * preset[1] / preset[0]);
      if (dom.exportH) dom.exportH.value = cfg.exportH;
    } else {
      cfg.exportH = Math.max(64, parseInt(dom.exportH?.value) || 1000);
    }
  }

  /* ── Dışa aktarma ────────────────────────────────────────── */
  async function exportCollage() {
    readCfg();
    const { cols, rows, gapH, gapV, bg, exportW: pw, exportH: ph } = cfg;

    const totalW = cols * pw + (cols - 1) * gapH;
    const totalH = rows * ph + (rows - 1) * gapV;

    const fig = document.createElement('canvas');
    fig.width = totalW; fig.height = totalH;
    const ctx = fig.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, totalW, totalH); }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx   = r * cols + c;
        const panel = panels[idx];
        if (!panel?.canvas) continue;

        const px = c * (pw + gapH);
        const py = r * (ph + gapV);

        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.clip();

        // Export ölçeğini doğrudan hesapla — önizleme ölçeğinden bağımsız
        const { sc: expSc, offX: expOffX, offY: expOffY } = panelTransform(panel, pw, ph);

        ctx.drawImage(panel.canvas,
          px + expOffX, py + expOffY,
          panel.canvas.width  * expSc,
          panel.canvas.height * expSc);

        // Etiket
        const ltext = getLabel(idx);
        if (ltext) {
          const lx  = px + (cfg.lpos.includes('r') ? pw - cfg.lsize - 14 : 14);
          const ly  = py + (cfg.lpos.includes('b') ? ph - 10             : 14 + cfg.lsize);
          ctx.font  = `bold ${cfg.lsize}px sans-serif`;
          if (cfg.labelBg) {
            const tw  = ctx.measureText(ltext).width;
            const pad = Math.round(cfg.lsize * 0.15);
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(lx - pad, ly - cfg.lsize - pad / 2, tw + pad * 2, cfg.lsize + pad);
          }
          ctx.fillStyle = cfg.labelColor;
          ctx.fillText(ltext, lx, ly);
        }
        ctx.restore();
      }
    }

    const fmt  = dom.exportFmt?.value || 'png';
    const qual = parseInt(dom.exportQ?.value) || 92;
    const ext  = fmt === 'jpeg' ? 'jpg' : fmt;

    const blob = await new Promise(resolve => {
      if (fmt === 'tiff') {
        const id  = fig.getContext('2d').getImageData(0, 0, fig.width, fig.height);
        const buf = UTIF.encodeImage(id.data, fig.width, fig.height);
        resolve(new Blob([buf], { type: 'image/tiff' }));
      } else {
        fig.toBlob(resolve, 'image/' + fmt, qual / 100);
      }
    });

    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'),
      { href: url, download: `figure_${cols}x${rows}.${ext}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ── Olayları bağla ──────────────────────────────────────── */
  function bindEvents() {
    [dom.cols, dom.rows, dom.bg, dom.lstyle, dom.lpos,
     dom.lsize, dom.lcolor, dom.lbg, dom.exportW].forEach(el => {
      if (!el) return;
      el.addEventListener('change', () => { readCfg(); renderGrid(); });
      el.addEventListener('input',  () => { readCfg(); renderGrid(); });
    });

    // Oran seçimi
    if (dom.aspect) {
      dom.aspect.addEventListener('change', () => {
        const isFree = dom.aspect.value === 'free';
        if (dom.exportHRow) dom.exportHRow.style.display = isFree ? '' : 'none';
        readCfg(); renderGrid();
      });
    }
    // exportH yalnızca "Serbest" modunda düzenlenebilir
    if (dom.exportH) {
      dom.exportH.addEventListener('change', () => { readCfg(); renderGrid(); });
      dom.exportH.addEventListener('input',  () => { readCfg(); renderGrid(); });
    }

    // Gap H / V / kilit
    if (dom.gapH) {
      dom.gapH.addEventListener('input', () => {
        if (dom.lockGap?.checked && dom.gapV) dom.gapV.value = dom.gapH.value;
        readCfg(); renderGrid();
      });
    }
    if (dom.gapV) dom.gapV.addEventListener('input', () => { readCfg(); renderGrid(); });
    if (dom.lockGap) {
      dom.lockGap.addEventListener('change', () => {
        if (dom.lockGap.checked && dom.gapV && dom.gapH) dom.gapV.value = dom.gapH.value;
        readCfg(); renderGrid();
      });
    }

    if (dom.exportFmt) {
      dom.exportFmt.addEventListener('change', () => {
        if (dom.exportQRow)
          dom.exportQRow.style.display = dom.exportFmt.value === 'jpeg' ? '' : 'none';
      });
    }
    if (dom.exportQ) {
      const qSpan = $c('vCgQ');
      dom.exportQ.addEventListener('input', () => { if (qSpan) qSpan.textContent = dom.exportQ.value; });
    }

    if (dom.btnAddAll) dom.btnAddAll.addEventListener('click', addFromEditor);
    if (dom.btnClear)  dom.btnClear.addEventListener('click',  () => { panels.length = 0; renderGrid(); });
    if (dom.btnExport) dom.btnExport.addEventListener('click', exportCollage);

    bindDropZone();
  }

  /* ── Sekme aktifleşince ──────────────────────────────────── */
  function onTabActivated() {
    setTimeout(() => { readCfg(); renderGrid(); }, 30);
  }

  /* ── İlk yükleme ─────────────────────────────────────────── */
  function init() {
    initDom();
    bindEvents();
    readCfg();
  }

  return { init, addFromEditor, onTabActivated };
})();
