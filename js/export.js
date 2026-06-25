'use strict';

/*
 * Export utilities.
 * Handles JPEG, PNG, TIFF output with DPI metadata and size control.
 */

/**
 * Export a canvas to a Blob with the given settings.
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {string}  opts.format      - 'jpeg'|'png'|'tiff'
 * @param {number}  opts.quality     - 0–1 (JPEG only)
 * @param {number}  opts.dpi         - DPI metadata
 * @param {number}  opts.maxDim      - resize longest edge to this (0 = keep original)
 * @returns {Promise<Blob>}
 */
async function exportCanvas(canvas, opts = {}) {
  const { format = 'jpeg', quality = 0.92, dpi = 300, maxDim = 0 } = opts;

  let srcCanvas = canvas;

  // Resize if needed
  if (maxDim > 0 && (canvas.width > maxDim || canvas.height > maxDim)) {
    srcCanvas = resizeCanvas(canvas, maxDim);
  }

  if (format === 'tiff') {
    return exportTiff(srcCanvas, dpi);
  }

  return new Promise((resolve, reject) => {
    if (format === 'jpeg') {
      srcCanvas.toBlob(blob => {
        if (!blob) { reject(new Error('JPEG dönüşümü başarısız')); return; }
        // Embed DPI in JFIF APP0 header
        embedJpegDpi(blob, dpi).then(resolve).catch(() => resolve(blob));
      }, 'image/jpeg', quality);
    } else {
      srcCanvas.toBlob(blob => {
        if (!blob) { reject(new Error('PNG dönüşümü başarısız')); return; }
        embedPngDpi(blob, dpi).then(resolve).catch(() => resolve(blob));
      }, 'image/png');
    }
  });
}

/** Resize canvas keeping aspect ratio, longest edge = maxDim. */
function resizeCanvas(src, maxDim) {
  let w = src.width, h = src.height;
  if (Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  dst.getContext('2d').drawImage(src, 0, 0, w, h);
  return dst;
}

/* ── JPEG DPI embedding ─────────────────────────────────────── */

async function embedJpegDpi(blob, dpi) {
  const buf = await blob.arrayBuffer();
  const arr = new Uint8Array(buf);
  // Find APP0 marker (FF E0) — starts right after SOI (FF D8)
  // We'll patch the JFIF Xdensity / Ydensity fields
  if (arr[0] !== 0xFF || arr[1] !== 0xD8) return blob; // not a JPEG
  if (arr[2] !== 0xFF || arr[3] !== 0xE0) return blob; // no APP0
  // JFIF header: APP0 marker (2) + length (2) + "JFIF\0" (5) + version (2) + units (1) + Xdensity (2) + Ydensity (2)
  // units byte at offset 11 (0=no units, 1=DPI, 2=DPcm)
  const jfifStart = 4;
  arr[jfifStart + 7]  = 1;               // units = DPI
  arr[jfifStart + 8]  = (dpi >> 8) & 0xFF;
  arr[jfifStart + 9]  = dpi & 0xFF;
  arr[jfifStart + 10] = (dpi >> 8) & 0xFF;
  arr[jfifStart + 11] = dpi & 0xFF;
  return new Blob([arr], { type: 'image/jpeg' });
}

/* ── PNG DPI embedding ──────────────────────────────────────── */

async function embedPngDpi(blob, dpi) {
  // pHYs chunk: pixels per unit X, Y (big-endian uint32) + unit (1 = meter)
  const ppm = Math.round(dpi / 0.0254); // dots per meter
  const buf = await blob.arrayBuffer();
  const arr = new Uint8Array(buf);

  // Find IDAT chunk position to insert pHYs before it
  const idatPos = findPngChunk(arr, 'IDAT');
  if (idatPos < 0) return blob;

  // Build pHYs chunk
  const phys = buildPngChunk('pHYs', new Uint8Array([
    (ppm >> 24) & 0xFF, (ppm >> 16) & 0xFF, (ppm >> 8) & 0xFF, ppm & 0xFF,
    (ppm >> 24) & 0xFF, (ppm >> 16) & 0xFF, (ppm >> 8) & 0xFF, ppm & 0xFF,
    1  // unit = meter
  ]));

  // Splice pHYs before IDAT
  const before = arr.slice(0, idatPos);
  const after  = arr.slice(idatPos);
  const out = new Uint8Array(arr.length + phys.length);
  out.set(before, 0);
  out.set(phys, before.length);
  out.set(after, before.length + phys.length);
  return new Blob([out], { type: 'image/png' });
}

function findPngChunk(arr, type) {
  const sig = type.split('').map(c => c.charCodeAt(0));
  for (let i = 8; i < arr.length - 8; ) {
    const len = (arr[i]<<24 | arr[i+1]<<16 | arr[i+2]<<8 | arr[i+3]) >>> 0;
    if (arr[i+4]===sig[0] && arr[i+5]===sig[1] && arr[i+6]===sig[2] && arr[i+7]===sig[3]) return i;
    i += 12 + len;
  }
  return -1;
}

function buildPngChunk(type, data) {
  const len = data.length;
  const chunk = new Uint8Array(12 + len);
  chunk[0] = (len >> 24) & 0xFF; chunk[1] = (len >> 16) & 0xFF;
  chunk[2] = (len >> 8)  & 0xFF; chunk[3] = len & 0xFF;
  for (let i = 0; i < 4; i++) chunk[4+i] = type.charCodeAt(i);
  chunk.set(data, 8);
  // CRC32
  const crc = crc32(chunk.slice(4, 8 + len));
  chunk[8+len]   = (crc >> 24) & 0xFF;
  chunk[9+len]   = (crc >> 16) & 0xFF;
  chunk[10+len]  = (crc >> 8)  & 0xFF;
  chunk[11+len]  = crc & 0xFF;
  return chunk;
}

// Simple CRC32
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) | 0;
}

/* ── TIFF export ────────────────────────────────────────────── */

/**
 * Minimal baseline TIFF writer (uncompressed RGB, big-endian).
 * Writes XResolution / YResolution IFD entries for DPI.
 */
function exportTiff(canvas, dpi) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = imageData.data;
  const w = canvas.width, h = canvas.height;

  // Convert RGBA → RGB (3 bytes per pixel)
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j]   = rgba[i];
    rgb[j+1] = rgba[i+1];
    rgb[j+2] = rgba[i+2];
  }

  // Build TIFF
  const IFD_ENTRY_SIZE = 12;
  const NUM_IFD = 11;
  const IFD_OFFSET = 8;
  const IFD_SIZE = 2 + NUM_IFD * IFD_ENTRY_SIZE + 4;
  // Extra data area (after IFD): BitsPerSample (3×2B), XRes rational (8B), YRes rational (8B)
  const EXTRA_OFFSET = IFD_OFFSET + IFD_SIZE;
  const EXTRA_SIZE = 6 + 8 + 8;  // bps(6) + xres(8) + yres(8)
  const IMAGE_OFFSET = EXTRA_OFFSET + EXTRA_SIZE;
  const totalSize = IMAGE_OFFSET + rgb.length;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // TIFF header (big-endian: 'MM' + 42 + offset to first IFD)
  view.setUint8(0, 0x4D); view.setUint8(1, 0x4D); // 'MM'
  view.setUint16(2, 42, false);
  view.setUint32(4, IFD_OFFSET, false);

  let pos = IFD_OFFSET;

  function writeShort(v) { view.setUint16(pos, v, false); pos += 2; }
  function writeLong(v)  { view.setUint32(pos, v, false); pos += 4; }

  // IFD entry: tag(2) + type(2) + count(4) + value/offset(4)
  function writeEntry(tag, type, count, value) {
    view.setUint16(pos, tag,   false); pos += 2;
    view.setUint16(pos, type,  false); pos += 2;
    view.setUint32(pos, count, false); pos += 4;
    view.setUint32(pos, value, false); pos += 4;
  }

  const BPS_OFFSET  = EXTRA_OFFSET;            // 3 × SHORT
  const XRES_OFFSET = EXTRA_OFFSET + 6;        // RATIONAL (2 × LONG)
  const YRES_OFFSET = EXTRA_OFFSET + 6 + 8;   // RATIONAL (2 × LONG)

  writeShort(NUM_IFD);
  // Tag, Type, Count, Value/Offset
  writeEntry(256,  3, 1, w);           // ImageWidth (SHORT)
  writeEntry(257,  3, 1, h);           // ImageLength (SHORT)
  writeEntry(258,  3, 3, BPS_OFFSET);  // BitsPerSample → offset
  writeEntry(259,  3, 1, 1);           // Compression = none
  writeEntry(262,  3, 1, 2);           // PhotometricInterpretation = RGB
  writeEntry(273,  4, 1, IMAGE_OFFSET);// StripOffsets
  writeEntry(278,  3, 1, h);           // RowsPerStrip
  writeEntry(279,  4, 1, rgb.length);  // StripByteCounts
  writeEntry(282,  5, 1, XRES_OFFSET); // XResolution → rational
  writeEntry(283,  5, 1, YRES_OFFSET); // YResolution → rational
  writeEntry(296,  3, 1, 2);           // ResolutionUnit = inch (DPI)
  writeLong(0); // Next IFD offset = 0 (last IFD)

  // Extra data
  pos = BPS_OFFSET;
  writeShort(8); writeShort(8); writeShort(8); // BitsPerSample: 8,8,8

  // XResolution rational: dpi/1
  pos = XRES_OFFSET;
  writeLong(dpi); writeLong(1);

  // YResolution rational: dpi/1
  pos = YRES_OFFSET;
  writeLong(dpi); writeLong(1);

  // Image data
  u8.set(rgb, IMAGE_OFFSET);

  return Promise.resolve(new Blob([buf], { type: 'image/tiff' }));
}

/* ── Batch export (ZIP) ─────────────────────────────────────── */

/**
 * Export multiple canvases as a ZIP file.
 * @param {Array<{canvas: HTMLCanvasElement, name: string}>} items
 * @param {object} opts - same as exportCanvas opts
 */
async function exportBatchAsZip(items, opts = {}) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip yüklü değil');
  const zip = new JSZip();
  const ext = opts.format === 'png' ? 'png' : opts.format === 'tiff' ? 'tif' : 'jpg';

  for (const { canvas, name } of items) {
    const blob = await exportCanvas(canvas, opts);
    const safeName = name.replace(/\.[^.]+$/, '') + '_duzeltilmis.' + ext;
    zip.file(safeName, blob);
  }

  return zip.generateAsync({ type: 'blob' });
}
