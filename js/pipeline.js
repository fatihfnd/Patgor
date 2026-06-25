/**
 * pipeline.js — Görüntü işleme hattı (OpenCV.js 4.8)
 *
 * Tek dışa aktarım: Pipeline.process(srcCanvas, opts, onProgress) → { imgData, stainType }
 * Pipeline.setPreset(name), Pipeline.setCustomRef(bgrMat)
 *
 * Her adımın başında console.log var.
 * Her cv.Mat sonunda delete() ile temizleniyor.
 * Her adım kendi içinde try/catch — hata olursa adım atlanır, zincir devam eder.
 */

const Pipeline = (() => {

  /* ── UI thread'i serbest bırak ───────────────────────────── */
  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  /* ── Yardımcılar ─────────────────────────────────────────── */
  function canvasToMat(canvas) {
    const imgData = canvas.getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);
    const rgba = cv.matFromImageData(imgData);
    const bgr  = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    rgba.delete();
    return bgr; // CV_8UC3
  }

  function matToImageData(bgr) {
    const rgba = new cv.Mat();
    cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
    const out = new ImageData(
      new Uint8ClampedArray(rgba.data),
      bgr.cols, bgr.rows
    );
    rgba.delete();
    return out;
  }

  /* ── Adım 1: Flat-field / vinyetleme ────────────────────── */
  function flatFieldCorrection(src, strength) {
    console.log('[pipeline] 1- flat-field  strength=' + strength);
    if (strength === 0) return src.clone();

    let k = Math.round(Math.min(src.cols, src.rows) * 0.15);
    if (k < 3) k = 3;
    if (k % 2 === 0) k += 1;

    const blurred = new cv.Mat();
    cv.GaussianBlur(src, blurred, new cv.Size(k, k), 0);

    const srcF   = new cv.Mat();
    const blurF  = new cv.Mat();
    src.convertTo(srcF, cv.CV_32F);
    blurred.convertTo(blurF, cv.CV_32F);
    blurred.delete();

    const meanVal  = cv.mean(blurF);
    const mb = (meanVal[0] + meanVal[1] + meanVal[2]) / 3 || 128;

    const corrF = new cv.Mat();
    cv.divide(srcF, blurF, corrF, mb);
    srcF.delete(); blurF.delete();

    const corr8 = new cv.Mat();
    corrF.convertTo(corr8, cv.CV_8U);
    corrF.delete();

    if (strength >= 100) return corr8;

    const alpha = strength / 100;
    cv.addWeighted(corr8, alpha, src, 1 - alpha, 0, corr8);
    return corr8;
  }

  /* ── Adım 2: Beyaz dengesi (Gray World) ──────────────────── */
  function whiteBalance(src) {
    console.log('[pipeline] 2- beyaz dengesi');
    const inChs = new cv.MatVector();
    cv.split(src, inChs);

    const means = [0, 1, 2].map(i => cv.mean(inChs.get(i))[0]);
    const avg   = (means[0] + means[1] + means[2]) / 3 || 128;

    const outChs = new cv.MatVector();
    cv.split(src, outChs);   // taze kopyalar

    for (let i = 0; i < 3; i++) {
      const scale = means[i] > 1 ? avg / means[i] : 1;
      outChs.get(i).convertTo(outChs.get(i), -1, scale, 0);
    }

    const result = new cv.Mat();
    cv.merge(outChs, result);

    for (let i = 0; i < 3; i++) { inChs.get(i).delete(); outChs.get(i).delete(); }
    inChs.delete(); outChs.delete();
    return result;
  }

  /* ── Adım 3: Boya algılama ───────────────────────────────── */
  function detectStain(bgr) {
    console.log('[pipeline] 3- boya algılama');
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    const chs = new cv.MatVector();
    cv.split(hsv, chs);
    hsv.delete();

    const rows = chs.get(0).rows, cols = chs.get(0).cols;
    // Hue 10-22 AND Saturation >60 → DAB kahve
    const loH = new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(10));
    const hiH = new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(22));
    const loS = new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(60));
    const hiS = new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(255));

    const mH = new cv.Mat(), mS = new cv.Mat(), mAnd = new cv.Mat();
    cv.inRange(chs.get(0), loH, hiH, mH);
    cv.inRange(chs.get(1), loS, hiS, mS);
    cv.bitwise_and(mH, mS, mAnd);
    const dabRatio = cv.countNonZero(mAnd) / (rows * cols);

    [loH, hiH, loS, hiS, mH, mS, mAnd].forEach(m => m.delete());
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete();

    const type = dabRatio > 0.03 ? 'ihk' : 'he';
    console.log('[pipeline] 3- boya algılama sonuç=' + type + ' dabRatio=' + dabRatio.toFixed(4));
    return type;
  }

  /* ── Adım 4: Reinhard boya normalizasyonu ────────────────── */
  // OpenCV Lab 8U: L∈[0,255], a∈[0,255] (128=nötr), b∈[0,255] (128=nötr)
  const PRESETS = {
    he_scanner: {
      meanL: 190, stdL: 40,
      meanA: 143, stdA: 12,
      meanB: 118, stdB: 10,
    },
    ihk_scanner: {
      meanL: 185, stdL: 42,
      meanA: 145, stdA: 14,
      meanB: 122, stdB: 12,
    },
  };

  let activePreset   = 'he_scanner';
  let customRefStats = null;

  function setPreset(name) {
    activePreset   = name;
    customRefStats = null;
    console.log('[pipeline] preset değişti: ' + name);
  }

  function chStats(ch32f) {
    const mMat = new cv.Mat(), sMat = new cv.Mat();
    cv.meanStdDev(ch32f, mMat, sMat);
    const m = mMat.data64F[0];
    const s = sMat.data64F[0] || 1;
    mMat.delete(); sMat.delete();
    return { mean: m, std: s };
  }

  function bgrToLabF(bgr) {
    const lab8 = new cv.Mat();
    cv.cvtColor(bgr, lab8, cv.COLOR_BGR2Lab);
    const lab32 = new cv.Mat();
    lab8.convertTo(lab32, cv.CV_32F);
    lab8.delete();
    return lab32;
  }

  function computeLabStats(bgr) {
    const lab32 = bgrToLabF(bgr);
    const chs   = new cv.MatVector();
    cv.split(lab32, chs);
    lab32.delete();
    const names = ['L', 'A', 'B'];
    const stats = {};
    for (let i = 0; i < 3; i++) {
      const s = chStats(chs.get(i));
      stats['mean' + names[i]] = s.mean;
      stats['std'  + names[i]] = s.std;
      chs.get(i).delete();
    }
    chs.delete();
    return stats;
  }

  function setCustomRef(bgr) {
    try {
      customRefStats = computeLabStats(bgr);
      console.log('[pipeline] özel referans istatistikleri hesaplandı', customRefStats);
    } catch (e) {
      console.error('[pipeline] setCustomRef hatası:', e);
      customRefStats = null;
    }
  }

  function reinhardNormalize(src, hemaScale, eosinScale) {
    console.log('[pipeline] 4- normalizasyon  hema=' + hemaScale + ' eosin=' + eosinScale);
    const ref = customRefStats || PRESETS[activePreset];

    const lab32 = bgrToLabF(src);
    const chs   = new cv.MatVector();
    cv.split(lab32, chs);
    lab32.delete();

    const names      = ['L', 'A', 'B'];
    // Kullanıcı kaydırıcıları sadece a/b kanallarını ölçekler
    const userScales = [1.0, hemaScale / 100, eosinScale / 100];

    for (let i = 0; i < 3; i++) {
      const ch = chs.get(i);
      const { mean: sM, std: sS } = chStats(ch);
      const rM  = ref['mean' + names[i]];
      const rS  = ref['std'  + names[i]] || 1;
      const sc  = (rS / sS) * userScales[i];
      ch.convertTo(ch, -1, sc, -sM * sc + rM);
    }

    const merged32 = new cv.Mat();
    cv.merge(chs, merged32);
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete();

    const merged8 = new cv.Mat();
    merged32.convertTo(merged8, cv.CV_8U);
    merged32.delete();

    const result = new cv.Mat();
    cv.cvtColor(merged8, result, cv.COLOR_Lab2BGR);
    merged8.delete();
    return result;
  }

  /* ── Adım 5: CLAHE kontrast ──────────────────────────────── */
  function applyCLAHE(src) {
    console.log('[pipeline] 5- kontrast (CLAHE)');
    const lab8 = new cv.Mat();
    cv.cvtColor(src, lab8, cv.COLOR_BGR2Lab);
    const chs = new cv.MatVector();
    cv.split(lab8, chs);
    lab8.delete();

    const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
    const lOut  = new cv.Mat();
    clahe.apply(chs.get(0), lOut);
    lOut.copyTo(chs.get(0));
    lOut.delete();
    clahe.delete();

    const merged = new cv.Mat();
    cv.merge(chs, merged);
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete();

    const result = new cv.Mat();
    cv.cvtColor(merged, result, cv.COLOR_Lab2BGR);
    merged.delete();
    return result;
  }

  /* ── Adım 5b: Unsharp mask keskinleştirme ────────────────── */
  function unsharpMask(src, amount) {
    console.log('[pipeline] 5- keskinlik amount=' + amount);
    if (amount === 0) return src.clone();
    const blur   = new cv.Mat();
    cv.GaussianBlur(src, blur, new cv.Size(5, 5), 2);
    const result = new cv.Mat();
    const a = 1 + amount / 100;
    const b = -(amount / 100);
    cv.addWeighted(src, a, blur, b, 0, result);
    blur.delete();
    return result;
  }

  /* ── Manuel ayarlar ──────────────────────────────────────── */
  function applyManual(src, opts) {
    console.log('[pipeline] manuel ayarlar');
    let mat = src.clone();

    // Parlaklık / kontrast
    const alpha = 1 + (opts.contrast  || 0) / 100;
    const beta  =     (opts.brightness || 0);
    if (Math.abs(alpha - 1) > 0.001 || Math.abs(beta) > 0.001) {
      const adj = new cv.Mat();
      mat.convertTo(adj, -1, alpha, beta);
      mat.delete();
      mat = adj;
    }

    // Doygunluk
    if (opts.saturation) {
      const hsv = new cv.Mat();
      cv.cvtColor(mat, hsv, cv.COLOR_BGR2HSV);
      const chs = new cv.MatVector();
      cv.split(hsv, chs);
      chs.get(1).convertTo(chs.get(1), -1, 1 + opts.saturation / 100, 0);
      cv.merge(chs, hsv);
      cv.cvtColor(hsv, mat, cv.COLOR_HSV2BGR);
      for (let i = 0; i < 3; i++) chs.get(i).delete();
      chs.delete(); hsv.delete();
    }

    // Renk sıcaklığı
    if (opts.temperature) {
      const chs = new cv.MatVector();
      cv.split(mat, chs);
      const t = opts.temperature / 100;
      chs.get(2).convertTo(chs.get(2), -1, 1 + t * 0.3, 0); // R
      chs.get(0).convertTo(chs.get(0), -1, 1 - t * 0.3, 0); // B
      cv.merge(chs, mat);
      for (let i = 0; i < 3; i++) chs.get(i).delete();
      chs.delete();
    }

    return mat;
  }

  /* ── Ana işleme fonksiyonu ───────────────────────────────── */
  async function process(srcCanvas, opts, onProgress) {
    const report = (pct, msg) => { if (onProgress) onProgress(pct, msg); };

    console.log('[pipeline] --- işleme başladı ---', opts);
    report(5, 'Görüntü okunuyor…');
    let mat = canvasToMat(srcCanvas);
    await yieldUI();

    // Boya algılama
    let stainType = opts.stainType;
    if (stainType === 'auto') {
      try { stainType = detectStain(mat); }
      catch (e) { console.warn('[pipeline] boya algılama hatası, he kabul edildi:', e); stainType = 'he'; }
      await yieldUI();
    }

    // Her adım için güvenli sarmalayıcı
    const runStep = async (label, pct, fn) => {
      report(pct, label);
      await yieldUI();
      try {
        const next = fn(mat);
        mat.delete();
        mat = next;
      } catch (e) {
        console.error('[pipeline] adım hatası [' + label + ']:', e.stack || e);
        // Adımı atla, mevcut mat ile devam et
      }
      await yieldUI();
    };

    if (opts.flatField) {
      await runStep('Işık eğimi düzeltiliyor…', 20,
        m => flatFieldCorrection(m, opts.flatFieldStrength ?? 50));
    }

    if (opts.whiteBalance) {
      await runStep('Beyaz dengesi ayarlanıyor…', 38, m => whiteBalance(m));
    }

    if (opts.stainNorm) {
      await runStep('Boya normalizasyonu…', 55,
        m => reinhardNormalize(m, opts.hemaScale ?? 100, opts.eosinScale ?? 100));
    }

    if (opts.clahe) {
      await runStep('Kontrast artırılıyor (CLAHE)…', 72, m => applyCLAHE(m));
    }

    if (opts.sharpen) {
      await runStep('Keskinleştirme…', 85,
        m => unsharpMask(m, opts.sharpenAmount ?? 60));
    }

    if (opts.applyManual) {
      await runStep('Manuel ayarlar…', 93, m => applyManual(m, opts));
    }

    report(98, 'Sonuç hazırlanıyor…');
    await yieldUI();
    const imgData = matToImageData(mat);
    mat.delete();

    console.log('[pipeline] --- işleme tamamlandı ---');
    return { imgData, stainType };
  }

  return { process, setPreset, setCustomRef, detectStain };
})();
