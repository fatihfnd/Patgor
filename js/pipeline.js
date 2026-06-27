/**
 * pipeline.js — Görüntü işleme hattı (OpenCV.js 4.8)
 *
 * Tek dışa aktarım: Pipeline.process(srcCanvas, opts, onProgress) → { imgData, stainType }
 * Pipeline.setPreset(name), Pipeline.setCustomRef(bgrMat)
 */

const Pipeline = (() => {

  /* ══════════════════════════════════════════════════════════
     HASSAS AYAR SABİTLERİ — buradan kolayca ince ayar yapılır
     ══════════════════════════════════════════════════════════ */
  const TUNE = {
    // Flat-field
    flatKernelFrac:    0.40,   // kernel = kısa kenar × oran — 0.40 → radyal haloyu kaldırır
    flatStrengthDef:   28,     // varsayılan güç (0-100); UI slider değeri geçer

    // Beyaz dengesi — parlak arka plan hedefi (255'e yakma)
    wbTarget:          245,

    // Reinhard normalizasyon karıştırma (0=orijinal, 1=tam normalize)
    normBlend:         0.65,   // eozin aşırı doygunlaşmasın

    // Gölge tabanı — siyah 0'dan bu değere kaldırılır (kromatin detayı)
    shadowBase:        6,

    // CLAHE
    claheClip:         1.5,    // 3.0 fazla agresifti
    claheTile:         8,

    // Arka plan / doku maskesi (HSV değerleri, 0-255 ölçeği)
    bgSatMax:          35,     // doygunluk < bu → arka plan
    bgValMin:          195,    // parlaklık > bu → arka plan
    bgWhiteTarget:     247,    // arka plan temizleme hedefi — lam camı renksizleştirme
    bgFeatherPx:       21,     // kenar yumuşatma yarıçapı (px, tek sayı)
    bgSmoothKernel:    9,      // arka plan temizleme kernel

    // Parlaklık koruması
    brightnessCompMax: 1.12,   // maksimum telafi katsayısı (aşırı aydınlatmayı önler)
  };
  /* ══════════════════════════════════════════════════════════ */

  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  /* ── Canvas ↔ Mat dönüşümleri ────────────────────────────── */
  function canvasToMat(canvas) {
    const imgData = canvas.getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);
    const rgba = cv.matFromImageData(imgData);
    const bgr  = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    rgba.delete();
    return bgr;
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

  /* ── İstatistik yardımcıları ─────────────────────────────── */
  function meanLuminance(bgr) {
    const lab = new cv.Mat();
    cv.cvtColor(bgr, lab, cv.COLOR_BGR2Lab);
    const m = cv.mean(lab);
    lab.delete();
    return m[0];  // L kanalı ortalaması
  }

  function meanSaturation(bgr) {
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    const chs = new cv.MatVector();
    cv.split(hsv, chs);
    const mS = cv.mean(chs.get(1))[0];
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete(); hsv.delete();
    return mS;
  }

  /* ── Merkez/kenar parlaklık oranı — gradyan ölçümü ──────── */
  function centerEdgeBrightness(bgr) {
    try {
      const gray = new cv.Mat();
      cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
      const r = gray.rows, c = gray.cols;
      const mg = Math.max(4, Math.floor(Math.min(r, c) * 0.08));
      const cw = Math.max(4, Math.floor(c * 0.15));
      const ch = Math.max(4, Math.floor(r * 0.15));

      const centerRoi = gray.roi(new cv.Rect(Math.floor(c/2) - cw, Math.floor(r/2) - ch, cw*2, ch*2));
      const cM = cv.mean(centerRoi)[0];
      centerRoi.delete();

      const strips = [
        gray.roi(new cv.Rect(0, 0, c, mg)),
        gray.roi(new cv.Rect(0, r - mg, c, mg)),
        gray.roi(new cv.Rect(0, 0, mg, r)),
        gray.roi(new cv.Rect(c - mg, 0, mg, r)),
      ];
      const eM = strips.reduce((s, m) => s + cv.mean(m)[0], 0) / strips.length;
      strips.forEach(m => m.delete());
      gray.delete();
      return { center: cM, edge: eM, ratio: eM > 0 ? cM / eM : 1 };
    } catch (_) { return { center: 0, edge: 0, ratio: 1 }; }
  }

  /* ── Adım 1: Flat-field / vinyetleme ────────────────────── */
  // Büyük kernel (kısa kenar × 0.25) → global ışık gradyanını tahmin eder,
  // lokal detayları korur → halo oluşmaz
  function flatFieldCorrection(src, strength) {
    console.log('[pipeline] 1- flat-field strength=' + strength
      + '  kernel=' + Math.round(Math.min(src.cols, src.rows) * TUNE.flatKernelFrac));
    if (strength === 0) return src.clone();

    const pre = centerEdgeBrightness(src);
    console.log('[pipeline] FF önce: merkez=' + pre.center.toFixed(1)
      + '  kenar=' + pre.edge.toFixed(1) + '  oran=' + pre.ratio.toFixed(3)
      + (pre.ratio > 1.05 ? '  (merkez parlak — halo var)' : ''));

    let k = Math.round(Math.min(src.cols, src.rows) * TUNE.flatKernelFrac);
    if (k < 3) k = 3;
    if (k % 2 === 0) k += 1;

    const srcF = new cv.Mat();
    src.convertTo(srcF, cv.CV_32F);

    const blurF = new cv.Mat();
    cv.GaussianBlur(srcF, blurF, new cv.Size(k, k), 0);

    const origMean = cv.mean(srcF);
    const mb = (origMean[0] + origMean[1] + origMean[2]) / 3 || 128;

    const corrF = new cv.Mat();
    cv.divide(srcF, blurF, corrF, mb);
    srcF.delete(); blurF.delete();

    const corr8 = new cv.Mat();
    corrF.convertTo(corr8, cv.CV_8U);
    corrF.delete();

    let result;
    if (strength >= 100) {
      result = corr8;
    } else {
      const alpha = strength / 100;
      result = new cv.Mat();
      cv.addWeighted(corr8, alpha, src, 1 - alpha, 0, result);
      corr8.delete();
    }

    const post = centerEdgeBrightness(result);
    console.log('[pipeline] FF sonra: merkez=' + post.center.toFixed(1)
      + '  kenar=' + post.edge.toFixed(1) + '  oran=' + post.ratio.toFixed(3)
      + (Math.abs(post.ratio - 1) < 0.05 ? '  ✓ düz' : ''));

    return result;
  }

  /* ── Adım 2: Beyaz dengesi (parlak piksel) ───────────────── */
  // Gray World H&E için yanlış (renkleri siler).
  // Bunun yerine: en parlak pikseller = boş lam camı = gerçek beyaz.
  // Hedef: wbTarget (~245) — 255'e yakılmaz, highlight clipping önlenir.
  function whiteBalance(src) {
    console.log('[pipeline] 2- beyaz dengesi (hedef=' + TUNE.wbTarget + ')');

    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);
    const mmRes = cv.minMaxLoc(gray);
    const thr   = Math.max(180, mmRes.maxVal * 0.85);
    const mask  = new cv.Mat();
    cv.threshold(gray, mask, thr, 255, cv.THRESH_BINARY);
    gray.delete();

    const inChs = new cv.MatVector();
    cv.split(src, inChs);
    const brightMeans = [0, 1, 2].map(
      i => cv.mean(inChs.get(i), mask)[0] || TUNE.wbTarget
    );
    mask.delete();

    const outChs = new cv.MatVector();
    cv.split(src, outChs);
    for (let i = 0; i < 3; i++) {
      const sc = brightMeans[i] > 10 ? TUNE.wbTarget / brightMeans[i] : 1;
      outChs.get(i).convertTo(outChs.get(i), -1, sc, 0);
      inChs.get(i).delete();
    }

    const result = new cv.Mat();
    cv.merge(outChs, result);
    for (let i = 0; i < 3; i++) outChs.get(i).delete();
    inChs.delete(); outChs.delete();

    console.log('[pipeline] 2- WB arka plan ortalamaları:',
      brightMeans.map(v => v.toFixed(1)));
    return result;
  }

  /* ── Arka plan / doku maskesi ────────────────────────────── */
  // HSV: düşük doygunluk + yüksek parlaklık → boş lam camı (arka plan)
  // Döndürür: CV_32F tek kanal, 1=arka plan, 0=doku (yumuşak kenarlar)
  function computeBackgroundMask(bgr) {
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    const chs = new cv.MatVector();
    cv.split(hsv, chs);
    hsv.delete();

    const satMask = new cv.Mat();
    const valMask = new cv.Mat();
    cv.threshold(chs.get(1), satMask, TUNE.bgSatMax, 255, cv.THRESH_BINARY_INV);
    cv.threshold(chs.get(2), valMask, TUNE.bgValMin, 255, cv.THRESH_BINARY);
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete();

    const bgMask8 = new cv.Mat();
    cv.bitwise_and(satMask, valMask, bgMask8);
    satMask.delete(); valMask.delete();

    // Float'a çevir → kenarları yumuşat (feather) → doku-arka plan sınırı yumuşak
    const bgMaskF = new cv.Mat();
    bgMask8.convertTo(bgMaskF, cv.CV_32F, 1.0 / 255);
    bgMask8.delete();

    const r       = TUNE.bgFeatherPx | 1;  // tek sayı
    const blurred = new cv.Mat();
    cv.GaussianBlur(bgMaskF, blurred, new cv.Size(r, r), r / 3.0);
    bgMaskF.delete();

    const bgPct = (cv.mean(blurred)[0] * 100).toFixed(1);
    const dkPct = (100 - parseFloat(bgPct)).toFixed(1);
    console.log('[pipeline] maske: arka plan=' + bgPct + '%  doku=' + dkPct + '%');

    return blurred;   // 0=doku, 1=arka plan, yumuşak geçiş
  }

  /* ── Maske ile karıştır ──────────────────────────────────── */
  // result = tissueImg × (1-bgMask) + bgImg × bgMask
  // bgMask CV_32F, tek kanal, 0=doku, 1=arka plan
  function blendWithMask(tissueImg, bgImg, bgMaskF32) {
    const tissueF = new cv.Mat();
    const bgF     = new cv.Mat();
    tissueImg.convertTo(tissueF, cv.CV_32F);
    bgImg.convertTo(bgF, cv.CV_32F);

    // Tek kanallı maskeyi 3 kanala genişlet
    const m0 = bgMaskF32.clone();
    const m1 = bgMaskF32.clone();
    const m2 = bgMaskF32.clone();
    const mv  = new cv.MatVector();
    mv.push_back(m0); mv.push_back(m1); mv.push_back(m2);
    const mask3 = new cv.Mat();
    cv.merge(mv, mask3);
    m0.delete(); m1.delete(); m2.delete(); mv.delete();

    // invMask = 1 - mask
    const ones3    = new cv.Mat(mask3.rows, mask3.cols, cv.CV_32FC3, new cv.Scalar(1, 1, 1, 0));
    const invMask3 = new cv.Mat();
    cv.subtract(ones3, mask3, invMask3);
    ones3.delete();

    const t3 = new cv.Mat();
    const b3 = new cv.Mat();
    cv.multiply(tissueF, invMask3, t3);
    cv.multiply(bgF,     mask3,    b3);
    tissueF.delete(); bgF.delete(); invMask3.delete(); mask3.delete();

    const resultF = new cv.Mat();
    cv.add(t3, b3, resultF);
    t3.delete(); b3.delete();

    const result = new cv.Mat();
    resultF.convertTo(result, cv.CV_8U);
    resultF.delete();
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
    console.log('[pipeline] 3- boya=' + type + ' dabRatio=' + dabRatio.toFixed(4));
    return type;
  }

  /* ── Adım 4: Reinhard normalizasyon ─────────────────────── */
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
    console.log('[pipeline] preset: ' + name);
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
    const lab8  = new cv.Mat();
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
      console.log('[pipeline] özel ref istatistikleri:', customRefStats);
    } catch (e) {
      console.error('[pipeline] setCustomRef hatası:', e);
      customRefStats = null;
    }
  }

  function clearCustomRef() {
    customRefStats = null;
    console.log('[pipeline] özel ref silindi, aktif preset: ' + activePreset);
  }

  // normBlend: normalize ile orijinali karıştır → eozin aşırı doygunlaşmaz
  function reinhardNormalize(src, hemaScale, eosinScale) {
    console.log('[pipeline] 4- normalizasyon  hema=' + hemaScale
      + ' eosin=' + eosinScale + ' blend=' + TUNE.normBlend);
    const ref = customRefStats || PRESETS[activePreset];

    const lab32 = bgrToLabF(src);
    const chs   = new cv.MatVector();
    cv.split(lab32, chs);
    lab32.delete();

    const names      = ['L', 'A', 'B'];
    const userScales = [1.0, hemaScale / 100, eosinScale / 100];

    for (let i = 0; i < 3; i++) {
      const ch = chs.get(i);
      const { mean: sM, std: sS } = chStats(ch);
      const rM = ref['mean' + names[i]];
      const rS = ref['std'  + names[i]] || 1;
      const sc = (rS / sS) * userScales[i];
      ch.convertTo(ch, -1, sc, -sM * sc + rM);
    }

    const merged32 = new cv.Mat();
    cv.merge(chs, merged32);
    for (let i = 0; i < 3; i++) chs.get(i).delete();
    chs.delete();

    const merged8 = new cv.Mat();
    merged32.convertTo(merged8, cv.CV_8U);
    merged32.delete();

    const normResult = new cv.Mat();
    cv.cvtColor(merged8, normResult, cv.COLOR_Lab2BGR);
    merged8.delete();

    // Özel ref varsa tam eşleştir (blend=1.0); preset'te blend<1 → yumuşak geçiş
    const blend = customRefStats ? 1.0 : TUNE.normBlend;
    console.log('[pipeline] norm blend=' + blend.toFixed(2)
      + (customRefStats ? ' (özel ref)' : ' (preset)'));
    const blended = new cv.Mat();
    cv.addWeighted(normResult, blend, src, 1 - blend, 0, blended);
    normResult.delete();
    return blended;
  }

  /* ── Adım 5a: CLAHE kontrast ─────────────────────────────── */
  // API build'e göre değişiyor → üç yol dene, hiçbiri yoksa normalize fallback
  function _makeCLAHE(clipLimit, tileSize) {
    if (typeof cv.CLAHE === 'function') {
      try {
        const c = new cv.CLAHE(clipLimit, tileSize);
        if (typeof c.apply === 'function') { console.log('[pipeline] CLAHE: new cv.CLAHE'); return c; }
        c.delete && c.delete();
      } catch (_) {}
      try {
        const c = new cv.CLAHE();
        if (c.setClipLimit)     c.setClipLimit(clipLimit);
        if (c.setTilesGridSize) c.setTilesGridSize(tileSize);
        if (typeof c.apply === 'function') { console.log('[pipeline] CLAHE: cv.CLAHE()+setters'); return c; }
        c.delete && c.delete();
      } catch (_) {}
    }
    if (typeof cv.createCLAHE === 'function') {
      try {
        const c = cv.createCLAHE(clipLimit, tileSize);
        if (typeof c.apply === 'function') { console.log('[pipeline] CLAHE: cv.createCLAHE'); return c; }
        c.delete && c.delete();
      } catch (_) {}
    }
    return null;
  }

  function applyCLAHE(src) {
    console.log('[pipeline] 5a- CLAHE clipLimit=' + TUNE.claheClip + ' tile=' + TUNE.claheTile);
    const lab8 = new cv.Mat();
    cv.cvtColor(src, lab8, cv.COLOR_BGR2Lab);
    const chs = new cv.MatVector();
    cv.split(lab8, chs);
    lab8.delete();

    const clahe = _makeCLAHE(TUNE.claheClip, new cv.Size(TUNE.claheTile, TUNE.claheTile));
    if (clahe) {
      const lOut = new cv.Mat();
      clahe.apply(chs.get(0), lOut);
      lOut.copyTo(chs.get(0));
      lOut.delete();
      clahe.delete();
    } else {
      console.warn('[pipeline] CLAHE API yok, normalize fallback');
      const lNorm = new cv.Mat();
      cv.normalize(chs.get(0), lNorm, 0, 255, cv.NORM_MINMAX);
      lNorm.copyTo(chs.get(0));
      lNorm.delete();
    }

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
    console.log('[pipeline] 5b- keskinlik amount=' + amount);
    if (amount === 0) return src.clone();
    const blur   = new cv.Mat();
    cv.GaussianBlur(src, blur, new cv.Size(5, 5), 2);
    const result = new cv.Mat();
    cv.addWeighted(src, 1 + amount / 100, blur, -(amount / 100), 0, result);
    blur.delete();
    return result;
  }

  /* ── Adım 2b: Highlight yumuşatma (soft clip) ───────────── */
  // knee–255 aralığını [knee, targetMax] aralığına yumuşak geçişle sıkıştırır.
  // cv.LUT ile piksel başına O(1) — cv.LUT(src, 1×256 CV_8U, dst) çağrısı.
  function highlightProtect(src, knee, targetMax) {
    knee      = (knee      !== undefined) ? knee      : 215;
    targetMax = (targetMax !== undefined) ? targetMax : 248;
    console.log('[pipeline] highlight knee=' + knee + ' targetMax=' + targetMax);

    const lutArr = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      if (v <= knee) {
        lutArr[v] = v;
      } else {
        const t      = (v - knee) / (255 - knee);
        const smooth = t * t * (3 - 2 * t);  // smoothstep
        lutArr[v]    = Math.round(knee + (targetMax - knee) * smooth);
      }
    }

    const lutMat = cv.matFromArray(1, 256, cv.CV_8U, Array.from(lutArr));
    const result = new cv.Mat();
    cv.LUT(src, lutMat, result);
    lutMat.delete();
    return result;
  }

  /* ── Yanmış piksel yüzdesi (≥249) ───────────────────────── */
  function burnedPixelPct(bgr) {
    try {
      const gray   = new cv.Mat();
      cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
      const thresh = new cv.Mat();
      cv.threshold(gray, thresh, 248, 255, cv.THRESH_BINARY);
      const pct = cv.countNonZero(thresh) / (bgr.rows * bgr.cols) * 100;
      gray.delete(); thresh.delete();
      return pct;
    } catch (_) { return 0; }
  }

  /* ── Adım 6: Gölge tabanı ────────────────────────────────── */
  // [0,255] → [shadowBase, 255]: siyah 0'dan shadowBase'e kaldırılır.
  // Kromatin ve nükleer detay korunur; siyaha yapışma önlenir.
  function liftShadows(src) {
    if (TUNE.shadowBase <= 0) return src.clone();
    const result = new cv.Mat();
    const scale  = (255 - TUNE.shadowBase) / 255;
    src.convertTo(result, -1, scale, TUNE.shadowBase);
    return result;
  }

  /* ── Dairesel görüş alanı tespiti + doldurma ─────────────── */
  // Telefon/oküler çekimlerinde daire dışı siyah alan istatistikleri bozar.
  // Daire kadrajdan taşmış / kaymış olsa bile çalışır: görünür parçadan tespit yapılır.
  function detectAndFillCircularFOV(src) {
    // 1. Gri + hafif blur → Otsu otomatik eşikleme
    //    Sabit eşik (28) yerine Otsu: halo ışık parlaklığına göre uyarlanır.
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);
    const gblur = new cv.Mat();
    cv.GaussianBlur(gray, gblur, new cv.Size(5, 5), 1);
    gray.delete();

    const thr = new cv.Mat();
    cv.threshold(gblur, thr, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    gblur.delete();

    // 2. Morfolojik açma + kapama
    //    Açma: halo ışık huzmesi benekleri kaybolur.
    //    Kapama: FOV içindeki küçük karanlık lekeler dolur.
    const ks = Math.max(15, (Math.round(Math.min(src.cols, src.rows) * 0.02) | 1));
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(ks, ks));
    const opened = new cv.Mat();
    const closed = new cv.Mat();
    cv.morphologyEx(thr, opened, cv.MORPH_OPEN,  kernel);
    cv.morphologyEx(opened, closed, cv.MORPH_CLOSE, kernel);
    kernel.delete(); thr.delete(); opened.delete();

    // 3. En büyük bağlı bileşen
    const contours  = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    closed.delete(); hierarchy.delete();

    if (contours.size() === 0) {
      contours.delete();
      console.log('[pipeline] daire güvenle bulunamadı: kontur yok — görüntü işleniyor');
      return { valid: false };
    }

    let maxArea = 0, maxIdx = 0;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > maxArea) { maxArea = a; maxIdx = i; }
    }

    const areaFrac = maxArea / (src.cols * src.rows);
    if (areaFrac < 0.15) {
      for (let i = 0; i < contours.size(); i++) contours.get(i).delete();
      contours.delete();
      console.log('[pipeline] daire güvenle bulunamadı: maskAlan='
        + (areaFrac * 100).toFixed(1) + '% (<15%) — görüntü olduğu gibi işleniyor');
      return { valid: false };
    }

    // 4. Merkez: momentlerden ağırlık merkezi
    const M  = cv.moments(contours.get(maxIdx), false);
    const cx = Math.round(M.m10 / M.m00);
    const cy = Math.round(M.m01 / M.m00);

    // 5. Yarıçap: iki tahmin, KÜÇÜK olanı al — halo/kaymış kadraj şişirmesini önle
    //    rBound = boundingRect kısa kenar / 2  (dış boyuta göre)
    //    rArea  = alan eşdeğeri r = √(A/π)    (iç doluluk'a göre)
    const rect   = cv.boundingRect(contours.get(maxIdx));
    const rBound = Math.round(Math.min(rect.width, rect.height) / 2);
    const rArea  = Math.round(Math.sqrt(maxArea / Math.PI));

    for (let i = 0; i < contours.size(); i++) contours.get(i).delete();
    contours.delete();

    const rRaw = Math.min(rBound, rArea);
    const r    = Math.round(rRaw * 0.95);  // %5 içeri: koyu kenar bandı dışarıda

    console.log('[pipeline] daire: cx=' + cx + ' cy=' + cy
      + ' rBound=' + rBound + ' rArea=' + rArea + ' rEff=' + r
      + ' maskAlan=' + (areaFrac * 100).toFixed(1) + '%'
      + ' img=' + src.cols + 'x' + src.rows);

    // 6. Feathered beyaz dolgu (245) — daire dışı nötr beyaz
    const FILL = 245;
    const hardMask = new cv.Mat(src.rows, src.cols, cv.CV_8U, new cv.Scalar(0));
    cv.circle(hardMask, new cv.Point(cx, cy), r, new cv.Scalar(255), -1);
    const featherPx = Math.max(3, Math.round(r * 0.015));
    const fk = (featherPx * 2 + 1) | 1;
    const softMask = new cv.Mat();
    cv.GaussianBlur(hardMask, softMask, new cv.Size(fk, fk), featherPx * 0.5);
    hardMask.delete();

    const src32   = new cv.Mat();
    src.convertTo(src32, cv.CV_32FC3, 1, 0);
    const alpha32 = new cv.Mat();
    softMask.convertTo(alpha32, cv.CV_32F, 1 / 255);
    softMask.delete();

    const a3 = new cv.Mat();
    const pv = new cv.MatVector();
    pv.push_back(alpha32); pv.push_back(alpha32); pv.push_back(alpha32);
    cv.merge(pv, a3);
    pv.delete(); alpha32.delete();

    const fill32 = new cv.Mat(src.rows, src.cols, cv.CV_32FC3,
      new cv.Scalar(FILL, FILL, FILL));
    const one = new cv.Mat(src.rows, src.cols, cv.CV_32FC3, new cv.Scalar(1, 1, 1));
    const oma = new cv.Mat();
    cv.subtract(one, a3, oma);
    one.delete();

    const sp = new cv.Mat(), fp = new cv.Mat(), b32 = new cv.Mat();
    cv.multiply(src32, a3, sp);
    cv.multiply(fill32, oma, fp);
    cv.add(sp, fp, b32);
    src32.delete(); fill32.delete(); a3.delete(); oma.delete(); sp.delete(); fp.delete();

    const result = new cv.Mat();
    b32.convertTo(result, cv.CV_8UC3, 1, 0);
    b32.delete();

    console.log('[pipeline] dışı beyaz feather ' + fk + 'px. Kare çıktı: ' + (r*2) + 'x' + (r*2));
    return { valid: true, result, cx, cy, r };
  }

  // 2r × 2r kare kırpma — merkezi (cx,cy), sınır dışı → beyaz (245) doldur
  function cropToCircleBounds(src, cx, cy, r) {
    const side = r * 2;
    const sx   = cx - r;
    const sy   = cy - r;

    // Sınır içi: basit ROI (zaten beyaz dolgulu)
    const x1 = Math.max(0, sx), y1 = Math.max(0, sy);
    const x2 = Math.min(src.cols, sx + side), y2 = Math.min(src.rows, sy + side);
    const cw = x2 - x1, ch = y2 - y1;

    let result;
    if (cw === side && ch === side) {
      result = src.roi(new cv.Rect(x1, y1, side, side)).clone();
    } else {
      // Sınır dışına taşıyor: beyaz zemine kopyala (kenar kare kalır)
      result = new cv.Mat(side, side, src.type(), new cv.Scalar(245, 245, 245, 255));
      if (cw > 0 && ch > 0) {
        const srcRoi = src.roi(new cv.Rect(x1, y1, cw, ch));
        const dstRoi = result.roi(new cv.Rect(x1 - sx, y1 - sy, cw, ch));
        srcRoi.copyTo(dstRoi);
        srcRoi.delete(); dstRoi.delete();
      }
    }

    console.log('[pipeline] kare kırpma: '
      + src.cols + 'x' + src.rows + ' → '
      + result.cols + 'x' + result.rows
      + (result.cols === result.rows ? ' ✓ kare' : ' ✗ KARE DEĞİL!'));
    return result;
  }

  /* ── Manuel ayarlar ──────────────────────────────────────── */
  function applyManual(src, opts) {
    console.log('[pipeline] manuel ayarlar');
    let mat = src.clone();

    const alpha = 1 + (opts.contrast  || 0) / 100;
    const beta  =     (opts.brightness || 0);
    if (Math.abs(alpha - 1) > 0.001 || Math.abs(beta) > 0.001) {
      const adj = new cv.Mat();
      mat.convertTo(adj, -1, alpha, beta);
      mat.delete();
      mat = adj;
    }

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

  /* ══════════════════════════════════════════════════════════
     ANA İŞLEME FONKSİYONU
     ══════════════════════════════════════════════════════════ */
  async function process(srcCanvas, opts, onProgress) {
    const report = (pct, msg) => { if (onProgress) onProgress(pct, msg); };

    console.log('[pipeline] ─── işleme başladı ───', opts);
    report(5, 'Görüntü okunuyor…');
    let mat = canvasToMat(srcCanvas);
    await yieldUI();

    // Her adım için güvenli sarmalayıcı — hata olsa bile zincir devam eder
    const logBGR = (label) => {
      try {
        const m = cv.mean(mat);
        console.log('[pipeline] ' + label + ' BGR=('
          + m[0].toFixed(1) + ',' + m[1].toFixed(1) + ',' + m[2].toFixed(1) + ')');
      } catch (_) {}
    };

    const runStep = async (label, pct, fn) => {
      report(pct, label);
      await yieldUI();
      logBGR('ÖNCESİ [' + label + ']');
      try {
        const next = fn(mat);
        mat.delete();
        mat = next;
        logBGR('SONRASI [' + label + ']');
      } catch (e) {
        console.error('[pipeline] adım hatası [' + label + ']:', e.stack || e);
      }
      await yieldUI();
    };

    // 0. Dairesel görüş alanı: dış siyah halkayı nötr değerle doldur
    //    (flat-field ve WB istatistiklerini korumak için sona kırpılır)
    let circleInfo = null;
    if (opts.cropBorder) {
      report(5, 'Dairesel alan tespit ediliyor…');
      await yieldUI();
      try {
        const ci = detectAndFillCircularFOV(mat);
        if (ci.valid) {
          mat.delete();
          mat = ci.result;
          circleInfo = { cx: ci.cx, cy: ci.cy, r: ci.r };
        }
      } catch (e) {
        console.warn('[pipeline] daire tespiti hatası:', e);
      }
    }

    // Boya algılama
    let stainType = opts.stainType;
    if (stainType === 'auto') {
      try { stainType = detectStain(mat); }
      catch (e) {
        console.warn('[pipeline] boya algılama hatası, he kabul edildi:', e);
        stainType = 'he';
      }
      await yieldUI();
    }

    // 1. Flat-field
    if (opts.flatField) {
      await runStep('Işık eğimi düzeltiliyor…', 12,
        m => flatFieldCorrection(m, opts.flatFieldStrength ?? TUNE.flatStrengthDef));
    }

    // 2. Beyaz dengesi
    if (opts.whiteBalance) {
      await runStep('Beyaz dengesi ayarlanıyor…', 25, m => whiteBalance(m));
    }

    // 2b. Highlight yumuşatma — WB sonrası zemin/parlak piksel clipping'i önle
    if (opts.whiteBalance || opts.flatField) {
      const before = burnedPixelPct(mat);
      await runStep('Highlight koruması…', 30, m => highlightProtect(m));
      console.log('[pipeline] yanmış piksel: önce=' + before.toFixed(2)
        + '%  sonra=' + burnedPixelPct(mat).toFixed(2) + '%');
    }

    // — Beyaz dengesi sonrası arka plan maskesi ve referans kopyasını hazırla —
    let bgMask  = null;
    const wbRef = mat.clone();  // CLAHE/sharpen'dan korunacak arka plan için referans

    // Konsol: işlem öncesi L ve S ortalamaları
    let preLMean = 0, preSMean = 0;
    try {
      preLMean = meanLuminance(mat);
      preSMean = meanSaturation(mat);
      console.log('[pipeline] ÖNCESİ → L=' + preLMean.toFixed(1)
        + '  S=' + preSMean.toFixed(1));
    } catch (_) {}

    try {
      report(33, 'Arka plan maskesi hesaplanıyor…');
      await yieldUI();
      bgMask = computeBackgroundMask(mat);
    } catch (e) {
      console.warn('[pipeline] arka plan maskesi oluşturulamadı:', e);
    }

    // 3. Boya normalizasyonu — TUNE.normBlend ile karıştırılır
    if (opts.stainNorm) {
      await runStep('Boya normalizasyonu…', 45,
        m => reinhardNormalize(m, opts.hemaScale ?? 100, opts.eosinScale ?? 100));
    }

    // 4. CLAHE — sadece L kanalında, hafifletilmiş (clipLimit 1.5)
    if (opts.clahe) {
      await runStep('Kontrast artırılıyor (CLAHE)…', 58, m => applyCLAHE(m));
    }

    // 5. Keskinleştirme — hafif (amount 40)
    if (opts.sharpen) {
      await runStep('Keskinleştirme…', 70,
        m => unsharpMask(m, opts.sharpenAmount ?? 40));
    }

    // 6. Gölge tabanı — siyaha yapışmayı önle, kromatin detayı koru
    await runStep('Gölge tabanı kaldırılıyor…', 78, m => liftShadows(m));

    // 7. Arka plan koruması: CLAHE/sharpen'ın arka plandaki gürültüyü abartmasını önle.
    //    Doku: işlenmiş hali kullan. Arka plan: wbRef'in yumuşatılmış halini geri yükle.
    if (bgMask) {
      report(85, 'Arka plan beyazlandırılıyor…');
      await yieldUI();
      try {
        // Zemin pikselleri düz temiz beyaza (247) çeker:
        //   - Normal lam görüntüsünde hafif renkli/gri cam zemini silinir
        //   - Telefon görüntüsünde daire-dışı dolgu zaten beyaz, maske orada güçlü
        //   - Doku bölgelerine dokunmaz (bgMask ≈ 0 orada)
        const bgWhite = new cv.Mat(mat.rows, mat.cols, cv.CV_8UC3,
          new cv.Scalar(TUNE.bgWhiteTarget, TUNE.bgWhiteTarget, TUNE.bgWhiteTarget));
        const blended = blendWithMask(mat, bgWhite, bgMask);
        bgWhite.delete();
        mat.delete();
        mat = blended;
        console.log('[pipeline] arka plan beyazlandı (hedef=' + TUNE.bgWhiteTarget + ')');
      } catch (e) {
        console.warn('[pipeline] arka plan karıştırma hatası:', e);
      }
    }

    // 8. Parlaklık telafisi — işlem görüntüyü belirgin kararttıysa telafi et
    try {
      const postLMean = meanLuminance(mat);
      const postSMean = meanSaturation(mat);
      console.log('[pipeline] SONRASI → L=' + postLMean.toFixed(1)
        + '  S=' + postSMean.toFixed(1)
        + '  (ΔL=' + (postLMean - preLMean).toFixed(1)
        + '  ΔS=' + (postSMean - preSMean).toFixed(1) + ')');

      const drop = preLMean - postLMean;
      if (drop > 5) {
        const comp      = Math.min(preLMean / postLMean, TUNE.brightnessCompMax);
        const brightened = new cv.Mat();
        mat.convertTo(brightened, -1, comp, 0);
        mat.delete();
        mat = brightened;
        console.log('[pipeline] parlaklık telafisi: ×' + comp.toFixed(3)
          + ' (L düşüşü ' + drop.toFixed(1) + ')');
      }
    } catch (e) {
      console.warn('[pipeline] parlaklık telafisi hatası:', e);
    }

    // 9. Manuel ayarlar
    if (opts.applyManual) {
      await runStep('Manuel ayarlar…', 93, m => applyManual(m, opts));
    }

    // Temizlik
    wbRef.delete();
    if (bgMask) bgMask.delete();

    // Son: dairesel kırpma — tüm renk işlemleri SONRASI (koordinatlar hâlâ geçerli)
    if (circleInfo) {
      try {
        const cropped = cropToCircleBounds(mat, circleInfo.cx, circleInfo.cy, circleInfo.r);
        mat.delete();
        mat = cropped;
      } catch (e) {
        console.warn('[pipeline] daire kırpma hatası:', e);
      }
    }

    report(98, 'Sonuç hazırlanıyor…');
    await yieldUI();
    const imgData = matToImageData(mat);
    mat.delete();

    console.log('[pipeline] ─── işleme tamamlandı ───');
    return { imgData, stainType };
  }

  return { process, setPreset, setCustomRef, clearCustomRef, detectStain };
})();
