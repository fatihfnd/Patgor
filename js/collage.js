/**
 * collage.js — Kolaj / Figür Düzenleyici
 * Bağımsız sekme; app.js state'ine (state.files) okuma erişimi var.
 */
'use strict';

const Collage = (() => {

  /* ── Sabitler ──────────────────────────────────────────────── */
  const MIN_CELL_PX = 80;

  /* ── Durum ────────────────────────────────────────────────── */
  // panels[i] = {canvas, previewSrc, offX, offY, scale} | null
  const panels  = [];
  const cfg     = {
    cols: 2, rows: 2, gapH: 8, gapV: 8, lockGap: true,
    bg: '#ffffff',
    labelStyle: 'upper', labelPos: 'tl',
    labelSize: 64, labelColor: '#ffffff', labelBg: true,
    exportW: 1000, exportH: 1000,
  };

  let dragSrcIdx = null;
  let panOp      = null;   // {idx, img, sox, soy, sx, sy}

  /* ── DOM ──────────────────────────────────────────────────── */
  const $c = id => document.getElementById(id);
  let dom  = {};

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
      exportW:    $c('cgExportW'),
      exportH:    $c('cgExportH'),
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

  function cellSize() {
    const aw = Math.max(300, (dom.gridWrap?.clientWidth || 700) - 4);
    const w  = Math.max(MIN_CELL_PX,
      Math.floor((aw - cfg.gapH * (cfg.cols - 1)) / cfg.cols));
    const h  = cfg.exportH > 0
      ? Math.round(w * cfg.exportH / cfg.exportW)
      : w;
    return { w, h };
  }

  function fitScale(canvas, cw, ch) {
    return Math.min(cw / canvas.width, ch / canvas.height);
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
      'padding:0; box-sizing:content-box',
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

    // Sürükle-bırak HEDEF (sıralama için)
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

      // Pan state yoksa başlangıç değerleri hesapla
      if (panel.scale === undefined) {
        const sc = fitScale(panel.canvas, w, h);
        panel.scale = sc;
        panel.offX  = (w - panel.canvas.width  * sc) / 2;
        panel.offY  = (h - panel.canvas.height * sc) / 2;
      }
      img.style.transform = `translate(${panel.offX}px,${panel.offY}px) scale(${panel.scale})`;
      div.appendChild(img);

      // Fare: pan
      div.addEventListener('mousedown', e => startPan(e, idx, img, div));
      // Tekerlek: zoom
      div.addEventListener('wheel', e => {
        e.preventDefault();
        handleZoom(e, idx, img, div);
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

      // Sürükle tutacağı (sağ-üst köşe)
      const handle = document.createElement('div');
      handle.className   = 'cg-handle';
      handle.draggable   = true;
      handle.title       = 'Sürükle (yer değiştir)';
      handle.textContent = '⠿';
      handle.addEventListener('mousedown', e => e.stopPropagation());
      handle.addEventListener('dragstart', e => onHandleDragStart(e, idx));
      div.appendChild(handle);

      // Çıkar düğmesi (X)
      const del = document.createElement('button');
      del.className   = 'cg-del';
      del.title       = 'Paneli kaldır';
      del.textContent = '×';
      del.addEventListener('mousedown', e => e.stopPropagation());
      del.addEventListener('click', () => { panels[idx] = null; renderGrid(); });
      div.appendChild(del);

    } else {
      // Boş hücre
      const empty = document.createElement('div');
      empty.className = 'cg-empty';
      empty.innerHTML = '＋<br><small>Yükle</small>';
      empty.addEventListener('click', () => pickFileForCell(idx));
      div.appendChild(empty);
    }

    dom.grid.appendChild(div);
  }

  /* ── Pan ──────────────────────────────────────────────────── */
  function startPan(e, idx, img, div) {
    if (e.button !== 0) return;
    const p = panels[idx];
    panOp = { idx, img, sox: p.offX, soy: p.offY, sx: e.clientX, sy: e.clientY };
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup',   onPanUp);
    e.preventDefault();
  }

  function onPanMove(e) {
    if (!panOp) return;
    const p = panels[panOp.idx];
    p.offX = panOp.sox + (e.clientX - panOp.sx);
    p.offY = panOp.soy + (e.clientY - panOp.sy);
    panOp.img.style.transform = `translate(${p.offX}px,${p.offY}px) scale(${p.scale})`;
  }

  function onPanUp() {
    panOp = null;
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup',   onPanUp);
  }

  /* ── Zoom ─────────────────────────────────────────────────── */
  function handleZoom(e, idx, img, div) {
    const p = panels[idx];
    const rect  = div.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 1.13 : 1 / 1.13;
    const oldSc = p.scale;
    const newSc = Math.max(0.05, Math.min(20, oldSc * delta));
    const ratio = newSc / oldSc;
    p.offX   = mx - ratio * (mx - p.offX);
    p.offY   = my - ratio * (my - p.offY);
    p.scale  = newSc;
    img.style.transform = `translate(${p.offX}px,${p.offY}px) scale(${p.scale})`;
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
    const { w, h } = cellSize();
    const sc = fitScale(canvas, w, h);
    return {
      canvas,
      previewSrc: null,
      scale: sc,
      offX: (w - canvas.width  * sc) / 2,
      offY: (h - canvas.height * sc) / 2,
    };
  }

  function pickFileForCell(idx) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.jpg,.jpeg,.png,.tif,.tiff';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      try {
        const canvas = await loadCanvasFromFile(inp.files[0]);
        panels[idx]  = makePanel(canvas);
        renderGrid();
      } catch (e) { console.error('[collage] hücre yükleme hatası:', e); }
    };
    inp.click();
  }

  /* ── Dışarıdan/drop-zone dosya ekle ──────────────────────── */
  function appendCanvas(canvas) {
    panels.push(makePanel(canvas));
  }

  function bindDropZone() {
    const dz = dom.drop;
    if (!dz) return;

    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('cg-dz-over'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('cg-dz-over'));
    dz.addEventListener('drop', async e => {
      e.preventDefault();
      dz.classList.remove('cg-dz-over');
      const files = [...e.dataTransfer.files].filter(f =>
        /\.(jpg|jpeg|png|tif|tiff)$/i.test(f.name));
      for (const f of files) {
        try { appendCanvas(await loadCanvasFromFile(f)); } catch (_) {}
      }
      renderGrid();
    });

    dz.addEventListener('click', () => dom.fileInput?.click());

    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', async e => {
        for (const f of e.target.files) {
          try { appendCanvas(await loadCanvasFromFile(f)); } catch (_) {}
        }
        renderGrid();
        dom.fileInput.value = '';
      });
    }
  }

  /* ── Editörden görüntü ekle ──────────────────────────────── */
  function addFromEditor() {
    if (typeof state === 'undefined' || !state.files) return;
    state.files.forEach(e => {
      const c = e.resultCanvas || e.origCanvas;
      if (c) appendCanvas(c);
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
    cfg.exportW    = Math.max(64, parseInt(dom.exportW?.value)  || 1000);
    cfg.exportH    = Math.max(64, parseInt(dom.exportH?.value)  || 1000);
  }

  /* ── Dışa aktarma (tam çözünürlük) ──────────────────────── */
  async function exportCollage() {
    readCfg();
    const { cols, rows, gapH, gapV, bg, exportW: pw, exportH: ph } = cfg;
    const { w: prevW, h: prevH } = cellSize();

    const totalW = cols * pw + (cols - 1) * gapH;
    const totalH = rows * ph + (rows - 1) * gapV;

    const fig = document.createElement('canvas');
    fig.width  = totalW;
    fig.height = totalH;
    const ctx  = fig.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, totalW, totalH);
    }

    const scaleX = pw / prevW;
    const scaleY = ph / prevH;

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

        const expScale = panel.scale * scaleX;
        const expOffX  = panel.offX  * scaleX;
        const expOffY  = panel.offY  * scaleY;

        ctx.drawImage(panel.canvas,
          px + expOffX, py + expOffY,
          panel.canvas.width  * expScale,
          panel.canvas.height * expScale);

        // Etiket
        const ltext = getLabel(idx);
        if (ltext) {
          const lx = px + (cfg.lpos.includes('r') ? pw - cfg.lsize - 14 : 14);
          const ly = py + (cfg.lpos.includes('b') ? ph - 10             : 14 + cfg.lsize);
          ctx.font = `bold ${cfg.lsize}px sans-serif`;
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
    const a   = Object.assign(document.createElement('a'),
      { href: url, download: `figure_${cols}x${rows}.${ext}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ── Olayları bağla ──────────────────────────────────────── */
  function bindEvents() {
    // Izgara / görünüm kontrolleri
    [dom.cols, dom.rows, dom.bg, dom.lstyle, dom.lpos,
     dom.lsize, dom.lcolor, dom.lbg, dom.exportW, dom.exportH].forEach(el => {
      if (!el) return;
      el.addEventListener('change', () => { readCfg(); renderGrid(); });
      el.addEventListener('input',  () => { readCfg(); renderGrid(); });
    });

    // Gap H / V / kilit
    if (dom.gapH) {
      dom.gapH.addEventListener('input', () => {
        if (dom.lockGap?.checked && dom.gapV)
          dom.gapV.value = dom.gapH.value;
        readCfg(); renderGrid();
      });
    }
    if (dom.gapV) {
      dom.gapV.addEventListener('input', () => { readCfg(); renderGrid(); });
    }
    if (dom.lockGap) {
      dom.lockGap.addEventListener('change', () => {
        if (dom.lockGap.checked && dom.gapV && dom.gapH)
          dom.gapV.value = dom.gapH.value;
        readCfg(); renderGrid();
      });
    }

    // Export format → kalite satırı
    if (dom.exportFmt) {
      dom.exportFmt.addEventListener('change', () => {
        if (dom.exportQRow)
          dom.exportQRow.style.display = dom.exportFmt.value === 'jpeg' ? '' : 'none';
      });
    }

    // Kalite göstergesi
    if (dom.exportQ) {
      const qSpan = document.getElementById('vCgQ');
      dom.exportQ.addEventListener('input', () => {
        if (qSpan) qSpan.textContent = dom.exportQ.value;
      });
    }

    // Düzeltme sekmesinden ekle
    if (dom.btnAddAll) dom.btnAddAll.addEventListener('click', addFromEditor);

    // Tümünü temizle
    if (dom.btnClear) dom.btnClear.addEventListener('click', () => {
      panels.length = 0;
      renderGrid();
    });

    // Dışa aktar
    if (dom.btnExport) dom.btnExport.addEventListener('click', exportCollage);

    bindDropZone();
  }

  /* ── Sekme aktifleşince yeniden çiz ─────────────────────── */
  function onTabActivated() {
    readCfg();
    // cellSize için gridWrap genişliği gerekiyor (hemen sonra okunur)
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
