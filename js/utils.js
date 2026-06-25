'use strict';

/* ── Image loading utilities ─────────────────────────────── */

/**
 * Load a File object into an HTMLImageElement, handling TIFF via UTIF.
 * Returns a Promise<{img: HTMLImageElement, width, height}>.
 */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'tif' || ext === 'tiff') {
      loadTiff(file).then(resolve).catch(reject);
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ img, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görüntü yüklenemedi')); };
      img.src = url;
    }
  });
}

/** Decode TIFF using UTIF.js and return an img-like result as ImageData. */
function loadTiff(file) {
  return new Promise((resolve, reject) => {
    if (typeof UTIF === 'undefined') {
      reject(new Error('UTIF.js yüklenemedi (TIFF desteği yok)'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ifds = UTIF.decode(e.target.result);
        UTIF.decodeImage(e.target.result, ifds[0]);
        const ifd = ifds[0];
        const w = ifd.width;
        const h = ifd.height;
        const rgba = UTIF.toRGBA8(ifd);
        // Draw onto offscreen canvas → HTMLImageElement
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(w, h);
        imageData.data.set(rgba);
        ctx.putImageData(imageData, 0, 0);
        // Convert canvas to img
        const img = new Image();
        img.onload = () => resolve({ img, width: w, height: h });
        img.src = canvas.toDataURL();
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('TIFF okunamadı'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Draw an Image into a canvas, fitting within maxDim while keeping aspect ratio.
 * Returns the canvas element.
 */
function imageToCanvas(img, maxDim = 0) {
  const canvas = document.createElement('canvas');
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (maxDim > 0 && Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas;
}

/**
 * Draw img src canvas into a display canvas element, scaling to fit CSS box.
 */
function renderToDisplayCanvas(srcCanvas, destCanvas) {
  destCanvas.width  = srcCanvas.width;
  destCanvas.height = srcCanvas.height;
  destCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);
}

/** Format bytes as human-readable string. */
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** Clamp v to [min, max]. */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Convert percent slider value (-100…+100) to a multiplier. */
function sliderToMult(v) { return 1 + v / 100; }

/** Deep copy ImageData pixels. */
function cloneImageData(id) {
  const c = new ImageData(new Uint8ClampedArray(id.data), id.width, id.height);
  return c;
}
