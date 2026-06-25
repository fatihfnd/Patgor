'use strict';

/*
 * Auto correction pipeline.
 * All heavy lifting via OpenCV.js (cv global).
 *
 * Steps (executed in order):
 *  1. flat-field / vignette correction
 *  2. white balance (gray world + brightest region)
 *  3. stain detection
 *  4. stain normalization (Reinhard Lab)
 *  5. CLAHE contrast enhancement
 *  6. unsharp mask sharpening
 */

/**
 * Run the full auto pipeline on a BGR cv.Mat.
 *
 * @param {cv.Mat}   srcMat       - Input BGR 8UC3
 * @param {object}   options
 * @param {string}   options.stainMode  - 'auto'|'he'|'ihk'|'histo'
 * @param {string}   options.refPreset  - preset key or 'custom'
 * @param {object}   options.refStats   - {mean, std} if custom ref
 * @param {function} options.onStep     - callback(stepName, done)
 * @returns {Promise<{mat: cv.Mat, stainType: string, steps: string[]}>}
 */
async function runAutoPipeline(srcMat, options = {}) {
  const { stainMode = 'auto', refPreset = 'builtin-he', refStats = null, onStep = () => {} } = options;
  const steps = [];

  // Clone so we don't mutate original
  let mat = srcMat.clone();

  /* ── Step 1: Flat-field correction ─────────────────────────── */
  onStep('flat-field', false);
  try {
    mat = applyFlatField(mat, options.flatFieldStrength ?? 80);
    steps.push({ name: 'Işık eğimi düzeltme', status: 'done' });
  } catch(e) {
    console.warn('flat-field hatası:', e);
    steps.push({ name: 'Işık eğimi düzeltme', status: 'skip' });
  }
  onStep('flat-field', true);
  await tick();

  /* ── Step 2: White balance ──────────────────────────────────── */
  onStep('white-balance', false);
  try {
    mat = applyWhiteBalance(mat);
    steps.push({ name: 'Beyaz dengesi', status: 'done' });
  } catch(e) {
    console.warn('white-balance hatası:', e);
    steps.push({ name: 'Beyaz dengesi', status: 'skip' });
  }
  onStep('white-balance', true);
  await tick();

  /* ── Step 3: Detect stain ───────────────────────────────────── */
  onStep('stain-detect', false);
  let stainType = stainMode === 'auto' ? detectStainType(mat) : stainMode;
  steps.push({ name: `Boya algılama: ${stainType.toUpperCase()}`, status: 'done' });
  onStep('stain-detect', true);
  await tick();

  /* ── Step 4: Stain normalization ────────────────────────────── */
  onStep('stain-norm', false);
  try {
    const targetStats = refStats || BUILTIN_REF_STATS[refPreset] || BUILTIN_REF_STATS['builtin-he'];
    const normalized = reinhardNormalize(mat, targetStats);
    mat.delete();
    mat = normalized;
    steps.push({ name: 'Boya normalizasyonu (Reinhard)', status: 'done' });
  } catch(e) {
    console.warn('normalizasyon hatası:', e);
    steps.push({ name: 'Boya normalizasyonu', status: 'skip' });
  }
  onStep('stain-norm', true);
  await tick();

  /* ── Step 5: CLAHE ──────────────────────────────────────────── */
  onStep('clahe', false);
  try {
    mat = applyCLAHE(mat);
    steps.push({ name: 'CLAHE kontrast', status: 'done' });
  } catch(e) {
    console.warn('CLAHE hatası:', e);
    steps.push({ name: 'CLAHE kontrast', status: 'skip' });
  }
  onStep('clahe', true);
  await tick();

  /* ── Step 6: Unsharp mask ───────────────────────────────────── */
  onStep('sharpen', false);
  try {
    mat = applyUnsharpMask(mat, 0.5);
    steps.push({ name: 'Unsharp mask keskinlik', status: 'done' });
  } catch(e) {
    console.warn('sharpen hatası:', e);
    steps.push({ name: 'Unsharp mask keskinlik', status: 'skip' });
  }
  onStep('sharpen', true);

  return { mat, stainType, steps };
}

/* ═══════════════════════════════════════════════════════════════
   Individual steps
   ═══════════════════════════════════════════════════════════════ */

/**
 * Flat-field / vignette correction.
 * Estimates background illumination using a large Gaussian blur,
 * then divides the image by it (element-wise).
 * strength: 0–100 (how aggressively to correct).
 */
function applyFlatField(mat, strength = 80) {
  const alpha = strength / 100;

  // Work in float
  const f32 = new cv.Mat();
  mat.convertTo(f32, cv.CV_32F, 1/255.0);

  // Large Gaussian to estimate illumination field
  const blurSize = computeBlurKernel(mat.cols, mat.rows);
  const bg = new cv.Mat();
  cv.GaussianBlur(f32, bg, new cv.Size(blurSize, blurSize), 0);

  // Correct: out = f32 / bg (add eps to avoid div-by-zero)
  const eps = new cv.Mat(f32.rows, f32.cols, cv.CV_32F, new cv.Scalar(1e-4));
  const bgSafe = new cv.Mat();
  cv.add(bg, eps, bgSafe);
  eps.delete(); bg.delete();

  const corrected = new cv.Mat();
  cv.divide(f32, bgSafe, corrected);
  f32.delete(); bgSafe.delete();

  // Normalize back: mean brightness should stay similar
  cv.normalize(corrected, corrected, 0, 1, cv.NORM_MINMAX);

  // Blend with original based on strength
  if (alpha < 1.0) {
    const orig32 = new cv.Mat();
    mat.convertTo(orig32, cv.CV_32F, 1/255.0);
    cv.addWeighted(corrected, alpha, orig32, 1 - alpha, 0, corrected);
    orig32.delete();
  }

  // Back to U8
  const result = new cv.Mat();
  corrected.convertTo(result, cv.CV_8U, 255.0);
  corrected.delete();
  mat.delete();
  return result;
}

/** Choose a blur kernel size ~1/5 of the shorter image dimension (must be odd ≥3). */
function computeBlurKernel(w, h) {
  let k = Math.floor(Math.min(w, h) / 5);
  if (k < 3) k = 3;
  if (k % 2 === 0) k++;
  return k;
}

/**
 * White balance: Gray World + brightest pixel stretch.
 * Ensures the slide background (bright, low-saturation regions) maps to white.
 */
function applyWhiteBalance(mat) {
  // Convert to float
  const f32 = new cv.Mat();
  mat.convertTo(f32, cv.CV_32F, 1/255.0);

  const channels = new cv.MatVector();
  cv.split(f32, channels);

  // Compute per-channel 99th percentile as white point
  const wp = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    wp[c] = percentile(channels.get(c).data32F, 0.99);
  }

  // Scale each channel so its white point maps to 1
  for (let c = 0; c < 3; c++) {
    if (wp[c] > 0.01) {
      cv.multiply(channels.get(c), new cv.Scalar(1.0 / wp[c]), channels.get(c));
    }
  }

  const merged = new cv.Mat();
  cv.merge(channels, merged);
  channels.delete(); f32.delete();

  // Clamp to [0,1] and convert back
  cv.threshold(merged, merged, 1.0, 1.0, cv.THRESH_TRUNC);
  cv.threshold(merged, merged, 0.0, 0.0, cv.THRESH_TOZERO);

  const result = new cv.Mat();
  merged.convertTo(result, cv.CV_8U, 255.0);
  merged.delete();
  mat.delete();
  return result;
}

/** Compute approximate p-th percentile of a Float32Array. */
function percentile(data, p) {
  const sorted = Float32Array.from(data).sort();
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

/**
 * CLAHE (Contrast Limited Adaptive Histogram Equalization).
 * Applied to the L channel in LAB space.
 */
function applyCLAHE(mat) {
  const lab = new cv.Mat();
  cv.cvtColor(mat, lab, cv.COLOR_BGR2Lab);

  const channels = new cv.MatVector();
  cv.split(lab, channels);

  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const lEq = new cv.Mat();
  clahe.apply(channels.get(0), lEq);
  clahe.delete();

  channels.get(0).delete();
  // Replace L channel
  const newChannels = new cv.MatVector();
  newChannels.push_back(lEq);
  newChannels.push_back(channels.get(1));
  newChannels.push_back(channels.get(2));

  const merged = new cv.Mat();
  cv.merge(newChannels, merged);
  channels.delete(); newChannels.delete(); lEq.delete(); lab.delete();

  const result = new cv.Mat();
  cv.cvtColor(merged, result, cv.COLOR_Lab2BGR);
  merged.delete();
  mat.delete();
  return result;
}

/**
 * Unsharp mask: result = mat + amount*(mat - blur).
 */
function applyUnsharpMask(mat, amount = 0.5) {
  const blurred = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(5, 5), 0);

  // mask = mat - blurred
  const mask = new cv.Mat();
  cv.subtract(mat, blurred, mask);
  blurred.delete();

  // result = mat + amount * mask
  const result = new cv.Mat();
  cv.addWeighted(mat, 1.0, mask, amount, 0, result);
  mask.delete();
  mat.delete();
  return result;
}

/* ═══════════════════════════════════════════════════════════════
   Manual adjustment
   ═══════════════════════════════════════════════════════════════ */

/**
 * Apply manual sliders to a BGR mat (does not mutate input).
 * Returns new cv.Mat.
 */
function applyManualAdjustments(srcMat, params) {
  const {
    brightness  = 0,   // -100…+100
    contrast    = 0,   // -100…+100
    saturation  = 0,   // -100…+100
    temperature = 0,   // -100…+100 (warm/cool)
    sharpness   = 0,   // 0…100
    flatField   = 0,   // 0…100
    hema        = 0,   // -100…+100
    eosin       = 0,   // -100…+100
    dab         = 0,   // -100…+100
  } = params;

  let mat = srcMat.clone();

  // Flat-field
  if (flatField > 0) {
    mat = applyFlatField(mat, flatField);
  }

  // Temperature: shift R and B channels
  if (temperature !== 0) {
    mat = applyTemperatureShift(mat, temperature);
  }

  // Brightness & contrast: convertTo(alpha, beta)
  // alpha = contrast gain, beta = brightness shift
  if (brightness !== 0 || contrast !== 0) {
    const alpha = 1.0 + contrast / 100;   // 0…2
    const beta  = brightness * 2.55;       // -255…+255 → OpenCV beta
    const tmp = new cv.Mat();
    mat.convertTo(tmp, -1, alpha, beta);
    mat.delete(); mat = tmp;
  }

  // Saturation: work in HSV
  if (saturation !== 0) {
    mat = applySaturation(mat, saturation);
  }

  // Stain channel adjustments (simplistic: shift in Lab a/b)
  if (hema !== 0 || eosin !== 0 || dab !== 0) {
    mat = applyStainChannelAdjust(mat, hema, eosin, dab);
  }

  // Sharpness
  if (sharpness > 0) {
    mat = applyUnsharpMask(mat, sharpness / 100);
  }

  return mat;
}

function applyTemperatureShift(mat, temp) {
  const channels = new cv.MatVector();
  cv.split(mat, channels);

  const shift = Math.round(temp * 0.8);
  // warm = more R, less B; cool = less R, more B
  channels.get(2).convertTo(channels.get(2), -1, 1,  shift);   // R
  channels.get(0).convertTo(channels.get(0), -1, 1, -shift);   // B

  const result = new cv.Mat();
  cv.merge(channels, result);
  channels.delete();
  mat.delete();
  return result;
}

function applySaturation(mat, amount) {
  const hsv = new cv.Mat();
  cv.cvtColor(mat, hsv, cv.COLOR_BGR2HSV);

  const channels = new cv.MatVector();
  cv.split(hsv, channels);

  const alpha = 1.0 + amount / 100;
  channels.get(1).convertTo(channels.get(1), -1, alpha, 0);

  const merged = new cv.Mat();
  cv.merge(channels, merged);
  channels.delete(); hsv.delete();

  const result = new cv.Mat();
  cv.cvtColor(merged, result, cv.COLOR_HSV2BGR);
  merged.delete(); mat.delete();
  return result;
}

function applyStainChannelAdjust(mat, hema, eosin, dab) {
  // Shift in Lab: hema → b channel (blue shift), eosin → a channel (red shift), dab → both a&b
  const lab = new cv.Mat();
  cv.cvtColor(mat, lab, cv.COLOR_BGR2Lab);

  const channels = new cv.MatVector();
  cv.split(lab, channels);

  // a channel: eosin (pink = high a) and dab (brown = high a)
  const aShift = (eosin + dab) * 0.3;
  // b channel: hema (blue = low b), dab (brown = high b)
  const bShift = -hema * 0.3 + dab * 0.15;

  channels.get(1).convertTo(channels.get(1), -1, 1, aShift);
  channels.get(2).convertTo(channels.get(2), -1, 1, bShift);

  const merged = new cv.Mat();
  cv.merge(channels, merged);
  channels.delete(); lab.delete();

  const result = new cv.Mat();
  cv.cvtColor(merged, result, cv.COLOR_Lab2BGR);
  merged.delete(); mat.delete();
  return result;
}

/* ── Helpers ─────────────────────────────────────────────────── */

/** Yield to the event loop so the browser can update UI. */
function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Copy an OpenCV mat to a display canvas element. */
function matToCanvas(mat, canvas) {
  const rgbaMat = new cv.Mat();
  if (mat.channels() === 3) {
    cv.cvtColor(mat, rgbaMat, cv.COLOR_BGR2RGBA);
  } else if (mat.channels() === 1) {
    cv.cvtColor(mat, rgbaMat, cv.COLOR_GRAY2RGBA);
  } else {
    mat.copyTo(rgbaMat);
  }
  canvas.width  = mat.cols;
  canvas.height = mat.rows;
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(new Uint8ClampedArray(rgbaMat.data), mat.cols, mat.rows);
  ctx.putImageData(imageData, 0, 0);
  rgbaMat.delete();
}

/** Load an HTMLImageElement (or canvas) into an OpenCV Mat (BGR). */
function imageToBGRMat(img) {
  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalWidth  || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const mat = cv.imread(canvas);
  // cv.imread returns RGBA; convert to BGR
  const bgr = new cv.Mat();
  cv.cvtColor(mat, bgr, cv.COLOR_RGBA2BGR);
  mat.delete();
  return bgr;
}

/** Load from canvas element. */
function canvasToBGRMat(canvas) {
  const mat = cv.imread(canvas);
  const bgr = new cv.Mat();
  cv.cvtColor(mat, bgr, cv.COLOR_RGBA2BGR);
  mat.delete();
  return bgr;
}
