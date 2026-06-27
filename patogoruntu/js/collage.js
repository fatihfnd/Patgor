/**
 * collage.js — Kolaj / Figür Düzenleyici
 *
 * Panel modeli (önizleme boyutundan bağımsız):
 *   zoomFactor : 1.0 = fit-inside, >1 = büyütme
 *   panFracX/Y : pan, canvas boyutunun kesri cinsinden (0,0 = ortalı)
 */
'use strict';

const Collage = (() => {

  const MIN_CELL_PX = 80;

  // Panel oranı ön ayarları (görsel hücre şekli + export H hesabı)
  const PANEL_ASPECT = {
    '1:1':  [1,  1],
    '4:3':  [4,  3],
    '3:2':  [3,  2],
    '16:9': [16, 9],
    'free': null,
  };

  /* ── Durum ──────────────────────────────────────────────── */
  const panels = [];  // {canvas, previewSrc, zoomFactor, panFracX, panFracY} | null
  const cfg = {
    cols: 2, rows: 2, gapH: 8, gapV: 8, lockGap: true,
    bg: '#ffffff',
    panelAspect: '1:1', panelAspectW: 1, panelAspectH: 1,
    labelStyle: 'upper', labelPos: 'tl',
    labelSize: 64, labelColor: '#ffffff', labelBg: true,
    labelFont: 'Arial,Helvetica,sans-serif',
    strokeEnable: false, strokeColor: '#000000', strokeWidth: 3,
    exportW: 1000,   // per-panel export genişlik; yük = exportW × panelAspectH/W
  };

  let dragSrcIdx   = null;
  let panOp        = null;
  let _collageZoom = 1.0;  // tüm kolaj önizlemesi zoom katsayısı

  /* ── DOM ────────────────────────────────────────────────── */
  const $c = id => document.getElementById(id);
  let dom = {};

  function initDom() {
    dom = {
      grid:         $c('cgGrid'),
      gridWrap:     $c('cgGridWrap'),
      drop:         $c('cgDropZone'),
      fileInput:    $c('cgFileInput'),
      cols:         $c('cgCols'),
      rows:         $c('cgRows'),
      gapH:         $c('cgGapH'),
      gapV:         $c('cgGapV'),
      lockGap:      $c('cgLockGap'),
      bg:           $c('cgBg'),
      panelAspect:  $c('cgPanelAspect'),
      panelSizeRow: $c('cgPanelSizeRow'),
      panelW:       $c('cgPanelW'),
      panelH:       $c('cgPanelH'),
      lstyle:       $c('cgLabelStyle'),
      lpos:         $c('cgLabelPos'),
      lsize:        $c('cgLabelSize'),
      lcolor:       $c('cgLabelColor'),
      lbg:          $c('cgLabelBg'),
      lFont:        $c('cgLabelFont'),
      strokeEnable: $c('cgStrokeEnable'),
      strokeColor:  $c('cgStrokeColor'),
      strokeWidth:  $c('cgStrokeWidth'),
      exportW:      $c('cgExportW'),
      exportHInfo:  $c('cgExportHInfo'),
      exportFmt:    $c('cgExportFmt'),
      exportQ:      $c('cgExportQ'),
      exportQRow:   $c('cgExportQRow'),
      btnExport:    $c('btnCgExport'),
      btnAddAll:    $c('btnCgAddAll'),
      btnClear:     $c('btnCgClear'),
    };
  }

  /* ── Yardımcı ───────────────────────────────────────────── */
  function getLabel(idx) {
    if (cfg.labelStyle === 'upper') return String.fromCharCode(65 + idx);
    if (cfg.labelStyle === 'lower') return String.fromCharCode(97 + idx);
    if (cfg.labelStyle === 'num')   return String(idx + 1);
    return '';
  }

  // Önizleme hücre boyutu
  function cellSize() {
    const aw = Math.max(320, (dom.gridWrap?.clientWidth || 720) - 4);
    const w  = Math.max(MIN_CELL_PX,
      Math.floor((aw - cfg.gapH * (cfg.cols - 1)) / cfg.cols));
    const h  = Math.round(w * cfg.panelAspectH / cfg.panelAspectW);
    return { w, h };
  }

  // canvas'ı cw×ch hücreye sığdıran ölçek
  function fitInside(canvas, cw, ch) {
    return Math.min(cw / canvas.width, ch / canvas.height);
  }

  // Her zaman taze transform (önizleme boyutundan bağımsız)
  function panelTransform(panel, cw, ch) {
    const sc  = fitInside(panel.canvas, cw, ch) * panel.zoomFactor;
    const offX = (cw - panel.canvas.width  * sc) / 2 + panel.panFracX * panel.canvas.width  * sc;
    const offY = (ch - panel.canvas.height * sc) / 2 + panel.panFracY * panel.canvas.height * sc;
    return { sc, offX, offY };
  }

  function labelPosCSS(pos) {
    return { tl: 'top:6px;left:6px', tr: 'top:6px;right:6px',
             bl: 'bottom:6px;left:6px', br: 'bottom:6px;right:6px' }[pos] || 'top:6px;left:6px';
  }

  /* ── Izgara ─────────────────────────────────────────────── */
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
    for (let i = 0; i < cfg.rows * cfg.cols; i++) buildCell(i, w, h);
    updateExportHInfo();
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
        + 'user-select:none;-webkit-user-select:none;pointer-events:none;width:auto;height:auto;';

      const { sc, offX, offY } = panelTransform(panel, w, h);
      img.style.transform = `translate(${offX}px,${offY}px) scale(${sc})`;
      div.appendChild(img);

      div.addEventListener('mousedown', e => startPan(e, idx, img, w, h));
      div.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();  // gridWrap'e kabarcıklanmayı durdur — panel kendi zoomunu yapar
        handleZoom(e, idx, img, w, h);
      }, { passive: false });

      // ── Etiket (position:absolute — layout'u itmez) ──
      const ltext = getLabel(idx);
      if (ltext) {
        // Önizleme font: cfg.labelSize'ı hücre/export oranıyla ölçekle
        // Böylece "Boyut" kaydırıcısı önizlemede de anında görünür, imge etkilenmez.
        const pxFont = Math.max(8, Math.round(cfg.labelSize * (w / Math.max(64, cfg.exportW))));

        // CSS kontur yaklaşımı (text-shadow)
        let strokeCSS = '';
        if (cfg.strokeEnable) {
          const sw = Math.min(3, cfg.strokeWidth); // CSS'te max 3px
          const sc = cfg.strokeColor;
          strokeCSS = `text-shadow:-${sw}px -${sw}px 0 ${sc},${sw}px -${sw}px 0 ${sc},`
                    + `-${sw}px ${sw}px 0 ${sc},${sw}px ${sw}px 0 ${sc};`;
        }

        const shadow = cfg.labelBg
          ? 'background:rgba(0,0,0,0.45);padding:1px 5px;border-radius:3px;'
          : '';

        const lb = document.createElement('div');
        lb.textContent = ltext;
        lb.style.cssText = `position:absolute;z-index:6;`
          + `font-size:${pxFont}px;font-weight:bold;`
          + `font-family:${cfg.labelFont};`
          + `color:${cfg.labelColor};`
          + shadow + strokeCSS
          + `${labelPosCSS(cfg.labelPos)};pointer-events:none;line-height:1.2;`;
        div.appendChild(lb);
        console.log('[collage] panel ' + idx + ': 1 etiket, konum=' + cfg.labelPos + ', px=' + pxFont);
      }

      const handle = document.createElement('div');
      handle.className = 'cg-handle'; handle.draggable = true;
      handle.title = 'Sürükle (yer değiştir)'; handle.textContent = '⠿';
      handle.addEventListener('mousedown', e => e.stopPropagation());
      handle.addEventListener('dragstart', e => onHandleDragStart(e, idx));
      div.appendChild(handle);

      const del = document.createElement('button');
      del.className = 'cg-del'; del.title = 'Paneli kaldır'; del.textContent = '×';
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

  function updateExportHInfo() {
    if (!dom.exportHInfo) return;
    const h = Math.round(cfg.exportW * cfg.panelAspectH / cfg.panelAspectW);
    dom.exportHInfo.textContent = h + ' px (oran ' + cfg.panelAspectW + ':' + cfg.panelAspectH + ')';
  }

  /* ── Pan ────────────────────────────────────────────────── */
  function startPan(e, idx, img, cw, ch) {
    if (e.button !== 0) return;
    const p = panels[idx];
    panOp = { idx, img, cw, ch,
      startX: p.panFracX, startY: p.panFracY, sx: e.clientX, sy: e.clientY };
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup',   onPanUp);
    e.preventDefault();
  }

  function onPanMove(e) {
    if (!panOp) return;
    const p = panels[panOp.idx];
    const { sc } = panelTransform(p, panOp.cw, panOp.ch);
    p.panFracX = panOp.startX + (e.clientX - panOp.sx) / (p.canvas.width  * sc);
    p.panFracY = panOp.startY + (e.clientY - panOp.sy) / (p.canvas.height * sc);
    const { offX, offY } = panelTransform(p, panOp.cw, panOp.ch);
    panOp.img.style.transform = `translate(${offX}px,${offY}px) scale(${sc})`;
  }

  function onPanUp() {
    panOp = null;
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup',   onPanUp);
  }

  /* ── Zoom ───────────────────────────────────────────────── */
  function handleZoom(e, idx, img, cw, ch) {
    const p    = panels[idx];
    const rect = img.closest('.cg-cell').getBoundingClientRect();
    const mx   = e.clientX - rect.left, my = e.clientY - rect.top;
    const d    = e.deltaY < 0 ? 1.13 : 1 / 1.13;

    const { sc: oldSc, offX: oldOX, offY: oldOY } = panelTransform(p, cw, ch);
    p.zoomFactor = Math.max(0.05, Math.min(20, p.zoomFactor * d));
    const newSc  = fitInside(p.canvas, cw, ch) * p.zoomFactor;
    const ratio  = newSc / oldSc;
    const nOX    = mx - ratio * (mx - oldOX);
    const nOY    = my - ratio * (my - oldOY);
    p.panFracX = (nOX - (cw - p.canvas.width  * newSc) / 2) / (p.canvas.width  * newSc);
    p.panFracY = (nOY - (ch - p.canvas.height * newSc) / 2) / (p.canvas.height * newSc);
    img.style.transform = `translate(${nOX}px,${nOY}px) scale(${newSc})`;
  }

  /* ── Sıralama ───────────────────────────────────────────── */
  function onHandleDragStart(e, idx) {
    dragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }

  function onCellDrop(e, tgtIdx) {
    e.preventDefault();
    dom.grid?.querySelectorAll('.cg-drop-over').forEach(el => el.classList.remove('cg-drop-over'));
    if (dragSrcIdx === null || dragSrcIdx === tgtIdx) { dragSrcIdx = null; return; }
    [panels[dragSrcIdx], panels[tgtIdx]] = [panels[tgtIdx], panels[dragSrcIdx]];
    dragSrcIdx = null;
    renderGrid();
  }

  /* ── Dosya yükleme ──────────────────────────────────────── */
  async function loadCanvasFromFile(file) {
    return new Promise((resolve, reject) => {
      const ext = file.name.split('.').pop().toLowerCase();
      if (['tif','tiff'].includes(ext)) {
        const r = new FileReader();
        r.onload = ev => {
          try {
            const buf = ev.target.result, ifds = UTIF.decode(buf);
            UTIF.decodeImage(buf, ifds[0]);
            const rgba = UTIF.toRGBA8(ifds[0]);
            const c = document.createElement('canvas');
            c.width = ifds[0].width; c.height = ifds[0].height;
            c.getContext('2d').putImageData(
              new ImageData(new Uint8ClampedArray(rgba), c.width, c.height), 0, 0);
            resolve(c);
          } catch (err) { reject(err); }
        };
        r.onerror = reject;
        r.readAsArrayBuffer(file);
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
    inp.type = 'file'; inp.accept = '.jpg,.jpeg,.png,.tif,.tiff';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      try { panels[idx] = makePanel(await loadCanvasFromFile(inp.files[0])); renderGrid(); }
      catch (e) { console.error('[collage] hücre yükleme:', e); }
    };
    inp.click();
  }

  /* ── Drop-zone ──────────────────────────────────────────── */
  function bindDropZone() {
    const dz = dom.drop;
    if (!dz) return;
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('cg-dz-over'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('cg-dz-over'));
    dz.addEventListener('drop', async e => {
      e.preventDefault(); dz.classList.remove('cg-dz-over');
      for (const f of [...e.dataTransfer.files].filter(f =>
          /\.(jpg|jpeg|png|tif|tiff)$/i.test(f.name)))
        try { panels.push(makePanel(await loadCanvasFromFile(f))); } catch (_) {}
      renderGrid();
    });
    dz.addEventListener('click', () => dom.fileInput?.click());
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', async e => {
        for (const f of e.target.files)
          try { panels.push(makePanel(await loadCanvasFromFile(f))); } catch (_) {}
        renderGrid(); dom.fileInput.value = '';
      });
    }
  }

  /* ── Editörden ekle ─────────────────────────────────────── */
  function addFromEditor() {
    if (typeof state === 'undefined' || !state.files) return;
    state.files.forEach(e => { const c = e.resultCanvas || e.origCanvas; if (c) panels.push(makePanel(c)); });
    renderGrid();
  }

  /* ── Kontrolleri oku ─────────────────────────────────────── */
  function readCfg() {
    cfg.cols    = Math.max(1, parseInt(dom.cols?.value)  || 2);
    cfg.rows    = Math.max(1, parseInt(dom.rows?.value)  || 2);
    cfg.gapH    = Math.max(0, parseInt(dom.gapH?.value)  || 0);
    cfg.gapV    = dom.lockGap?.checked ? cfg.gapH : Math.max(0, parseInt(dom.gapV?.value) || 0);
    cfg.bg      = dom.bg?.value || '#ffffff';

    // Panel oranı (C) — hücre şekli + export H hesabı
    cfg.panelAspect = dom.panelAspect?.value || '1:1';
    const preset = PANEL_ASPECT[cfg.panelAspect];
    const isFree = !preset;
    if (dom.panelSizeRow) dom.panelSizeRow.style.display = isFree ? '' : 'none';
    if (preset) {
      cfg.panelAspectW = preset[0];
      cfg.panelAspectH = preset[1];
    } else {
      cfg.panelAspectW = Math.max(1, parseInt(dom.panelW?.value) || 4);
      cfg.panelAspectH = Math.max(1, parseInt(dom.panelH?.value) || 3);
    }

    // Etiket (D+E) — labelSize export'ta kullanılır; önizleme pxFont'u bağımsız
    cfg.labelStyle  = dom.lstyle?.value  || 'upper';
    cfg.labelPos    = dom.lpos?.value    || 'tl';
    cfg.labelSize   = Math.max(8, parseInt(dom.lsize?.value) || 64);   // D: sadece export
    cfg.labelColor  = dom.lcolor?.value  || '#ffffff';
    cfg.labelBg     = dom.lbg?.checked  !== false;
    cfg.labelFont   = dom.lFont?.value   || 'Arial,Helvetica,sans-serif';
    cfg.strokeEnable = dom.strokeEnable?.checked || false;
    cfg.strokeColor  = dom.strokeColor?.value  || '#000000';
    cfg.strokeWidth  = Math.max(1, parseInt(dom.strokeWidth?.value) || 3);

    // Export
    cfg.exportW = Math.max(64, parseInt(dom.exportW?.value) || 1000);
  }

  /* ── Export ─────────────────────────────────────────────── */
  async function exportCollage() {
    readCfg();
    const { cols, rows, gapH, gapV, bg, exportW: pw } = cfg;
    const ph = Math.round(pw * cfg.panelAspectH / cfg.panelAspectW); // per-panel H from aspect

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

        const px = c * (pw + gapH), py = r * (ph + gapV);
        ctx.save();
        ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();

        // Export ölçeği doğrudan hesaplanır (D: önizleme boyutundan bağımsız)
        const { sc, offX, offY } = panelTransform(panel, pw, ph);
        ctx.drawImage(panel.canvas, px + offX, py + offY,
          panel.canvas.width * sc, panel.canvas.height * sc);

        // Etiket (E: font + kontur)
        const ltext = getLabel(idx);
        if (ltext) {
          ctx.font         = `bold ${cfg.labelSize}px ${cfg.labelFont}`;
          ctx.textBaseline = 'top';   // ly = metnin görsel üst kenarı
          ctx.textAlign    = 'left';  // lx = metnin sol kenarı
          const tw   = ctx.measureText(ltext).width;
          const pad  = Math.round(cfg.labelSize * 0.15);
          const lPad = Math.max(8, Math.round(Math.min(pw, ph) * 0.012));
          const isR  = cfg.labelPos.includes('r');
          const isB  = cfg.labelPos.includes('b');
          // Metnin sol-üst köşesi (önizleme CSS köşe + padding ile birebir uyumlu)
          const txL  = px + (isR ? pw - lPad - tw : lPad);
          const tyT  = py + (isB ? ph - lPad - cfg.labelSize : lPad);

          if (cfg.labelBg) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(txL - pad, tyT - Math.round(pad * 0.5), tw + pad * 2, cfg.labelSize + pad);
          }
          if (cfg.strokeEnable) {
            ctx.strokeStyle = cfg.strokeColor;
            ctx.lineWidth   = cfg.strokeWidth;
            ctx.lineJoin    = 'round';
            ctx.strokeText(ltext, txL, tyT);
          }
          ctx.fillStyle = cfg.labelColor;
          ctx.fillText(ltext, txL, tyT);
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
        resolve(new Blob([UTIF.encodeImage(id.data, fig.width, fig.height)], { type:'image/tiff' }));
      } else {
        fig.toBlob(resolve, 'image/' + fmt, qual / 100);
      }
    });

    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'),
      { href: url, download: `figure_${cols}x${rows}.${ext}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ── Olayları bağla ─────────────────────────────────────── */
  function bindEvents() {
    const rerender = () => { readCfg(); renderGrid(); };

    // Izgara kontrolleri
    [dom.cols, dom.rows, dom.bg, dom.panelAspect,
     dom.panelW, dom.panelH].forEach(el => {
      if (!el) return;
      el.addEventListener('change', rerender);
      el.addEventListener('input',  rerender);
    });

    // Gap H / V / kilit
    if (dom.gapH) dom.gapH.addEventListener('input', () => {
      if (dom.lockGap?.checked && dom.gapV) dom.gapV.value = dom.gapH.value;
      rerender();
    });
    if (dom.gapV)    dom.gapV.addEventListener('input',    rerender);
    if (dom.lockGap) dom.lockGap.addEventListener('change', () => {
      if (dom.lockGap.checked && dom.gapV && dom.gapH) dom.gapV.value = dom.gapH.value;
      rerender();
    });

    // Etiket kontrolleri (D: labelSize sadece renderGrid tetikler, image boyutunu etkilemez)
    [dom.lstyle, dom.lpos, dom.lsize, dom.lcolor, dom.lbg,
     dom.lFont, dom.strokeEnable, dom.strokeColor, dom.strokeWidth].forEach(el => {
      if (!el) return;
      el.addEventListener('change', rerender);
      el.addEventListener('input',  rerender);
    });

    // Export
    if (dom.exportW) {
      dom.exportW.addEventListener('input',  rerender);
      dom.exportW.addEventListener('change', rerender);
    }
    if (dom.exportFmt) dom.exportFmt.addEventListener('change', () => {
      if (dom.exportQRow)
        dom.exportQRow.style.display = dom.exportFmt.value === 'jpeg' ? '' : 'none';
    });
    if (dom.exportQ) {
      const qSpan = $c('vCgQ');
      dom.exportQ.addEventListener('input', () => { if (qSpan) qSpan.textContent = dom.exportQ.value; });
    }

    if (dom.btnAddAll) dom.btnAddAll.addEventListener('click', addFromEditor);
    if (dom.btnClear)  dom.btnClear.addEventListener('click',  () => { panels.length = 0; renderGrid(); });
    if (dom.btnExport) dom.btnExport.addEventListener('click', exportCollage);

    // Genel kolaj zoom — imlecin panel DIŞINDA olduğu tekerlek olayları
    // Panel wheel stopPropagation yaptığı için buraya yalnızca boş alan olayları ulaşır.
    if (dom.gridWrap) {
      dom.gridWrap.addEventListener('wheel', e => {
        e.preventDefault();
        const d = e.deltaY < 0 ? 1.13 : 1 / 1.13;
        _collageZoom = Math.max(0.15, Math.min(5, _collageZoom * d));
        if (dom.grid) {
          dom.grid.style.transform      = 'scale(' + _collageZoom + ')';
          dom.grid.style.transformOrigin = 'top center';
        }
        console.log('[collage] genel zoom=' + _collageZoom.toFixed(2));
      }, { passive: false });
    }

    bindDropZone();
  }

  /* ── Sekme aktifleşince ─────────────────────────────────── */
  function onTabActivated() {
    setTimeout(() => { readCfg(); renderGrid(); }, 30);
  }

  /* ── İlk yükleme ────────────────────────────────────────── */
  function init() {
    initDom();
    bindEvents();
    readCfg();
  }

  return { init, addFromEditor, onTabActivated };
})();
