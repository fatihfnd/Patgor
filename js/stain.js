'use strict';

/*
 * Stain detection & normalization helpers.
 *
 * References:
 *  - Ruifrok & Johnston (2001) color deconvolution
 *  - Macenko et al. (2009) stain normalization
 *  - Reinhard et al. (2001) color transfer in Lab
 */

/* ── Ruifrok–Johnston stain vectors ─────────────────────────── */

const STAIN_VECTORS = {
  he: {
    // Hematoksilen & Eozin — RGB absorbance
    h:    [0.6500286, 0.7044268, 0.2860126],  // hematoksilen
    e:    [0.2663478, 0.8428473, 0.4681820],  // eozin
    bg:   [0.0, 0.0, 0.0],
  },
  ihk: {
    // Hematoksilen & DAB
    h:    [0.6500286, 0.7044268, 0.2860126],
    e:    [0.2690543, 0.5684553, 0.7785024],  // DAB
    bg:   [0.0, 0.0, 0.0],
  },
  histo: {
    // Alcian Blue & PAS (genel histokimya tahmini)
    h:    [0.8753688, 0.4124751, 0.2563004],
    e:    [0.5529847, 0.8326294, 0.0399534],
    bg:   [0.0, 0.0, 0.0],
  }
};

/**
 * Detect stain type from mean RGB of the image.
 * Very lightweight heuristic; proper Macenko SVD is in pipeline.js.
 * Returns 'he' | 'ihk' | 'histo'.
 */
function detectStainType(mat) {
  // Sample a small version for speed
  const small = new cv.Mat();
  cv.resize(mat, small, new cv.Size(128, 128), 0, 0, cv.INTER_AREA);

  const lab = new cv.Mat();
  cv.cvtColor(small, lab, cv.COLOR_BGR2Lab);

  const channels = new cv.MatVector();
  cv.split(lab, channels);
  const meanL = cv.mean(channels.get(0))[0];
  const meanA = cv.mean(channels.get(1))[0];
  const meanB = cv.mean(channels.get(2))[0];

  channels.delete(); lab.delete(); small.delete();

  // LAB interpretation (OpenCV: L 0-255, a 0-255 centered ~128, b 0-255 centered ~128)
  const a = meanA - 128;
  const b = meanB - 128;

  // Strong brown (DAB) → positive a, positive b shift
  if (a > 10 && b > 8) return 'ihk';
  // Purple/blue dominant (H&E hematoksilen) → negative b
  if (b < -5 && a > -5) return 'he';
  // Otherwise default
  return 'he';
}

/**
 * Ruifrok–Johnston color deconvolution.
 * Input: BGR cv.Mat (CV_8UC3).
 * Returns: { h: cv.Mat, e: cv.Mat, bg: cv.Mat } — each 32F single-channel (0..1 optical density).
 */
function colorDeconvolve(mat, stainType) {
  const sv = STAIN_VECTORS[stainType] || STAIN_VECTORS.he;

  const w  = mat.cols;
  const h  = mat.rows;
  const out = { h: new cv.Mat(h, w, cv.CV_32F), e: new cv.Mat(h, w, cv.CV_32F), bg: new cv.Mat(h, w, cv.CV_32F) };

  // Build 3×3 deconvolution matrix (inverse of stain matrix)
  const M = [
    sv.h[0], sv.h[1], sv.h[2],
    sv.e[0], sv.e[1], sv.e[2],
    0.0,     0.0,     0.0
  ];

  // Compute third row orthogonally
  const cross = [
    M[1]*M[5] - M[2]*M[4],
    M[2]*M[3] - M[0]*M[5],
    M[0]*M[4] - M[1]*M[3]
  ];
  const norm = Math.sqrt(cross[0]**2 + cross[1]**2 + cross[2]**2) || 1;
  M[6] = cross[0]/norm; M[7] = cross[1]/norm; M[8] = cross[2]/norm;

  // Invert M (simple 3×3 using cofactors)
  const inv = invert3x3(M);
  if (!inv) {
    // Fallback: return empty channels
    return out;
  }

  // Convert to float32 and log-transform (OD = -log(I/255))
  const float32 = new cv.Mat();
  mat.convertTo(float32, cv.CV_32F, 1/255.0);

  const bgr = new cv.MatVector();
  cv.split(float32, bgr);
  float32.delete();

  // OD channels (clamp to avoid log(0))
  const eps = 1e-6;
  for (let c = 0; c < 3; c++) {
    const ch = bgr.get(c);
    // OD = -log(pixel + eps)
    for (let i = 0; i < ch.rows * ch.cols; i++) {
      let v = ch.floatAt(i, 0);
      if (v < eps) v = eps;
      ch.data32F[i] = -Math.log(v);
    }
    bgr.get(c).delete(); // will rebuild
  }

  // For performance, use plain JS typed array approach
  const dataB = mat.data;
  const odH = out.h.data32F;
  const odE = out.e.data32F;
  const odBg = out.bg.data32F;
  const n = w * h;

  for (let i = 0; i < n; i++) {
    const pi = i * mat.channels();
    const r = Math.max(dataB[pi+2], 1) / 255;
    const g = Math.max(dataB[pi+1], 1) / 255;
    const b = Math.max(dataB[pi+0], 1) / 255;
    const odR = -Math.log(r);
    const odG = -Math.log(g);
    const odBl = -Math.log(b);

    odH[i]  = inv[0]*odR + inv[1]*odG + inv[2]*odBl;
    odE[i]  = inv[3]*odR + inv[4]*odG + inv[5]*odBl;
    odBg[i] = inv[6]*odR + inv[7]*odG + inv[8]*odBl;
  }

  bgr.delete();
  return out;
}

/** 3×3 matrix inversion (row-major). Returns null if singular. */
function invert3x3(m) {
  const [a,b,c,d,e,f,g,h,k] = m;
  const det = a*(e*k - f*h) - b*(d*k - f*g) + c*(d*h - e*g);
  if (Math.abs(det) < 1e-10) return null;
  const inv = new Float64Array(9);
  inv[0] =  (e*k - f*h) / det;
  inv[1] = -(b*k - c*h) / det;
  inv[2] =  (b*f - c*e) / det;
  inv[3] = -(d*k - f*g) / det;
  inv[4] =  (a*k - c*g) / det;
  inv[5] = -(a*f - c*d) / det;
  inv[6] =  (d*h - e*g) / det;
  inv[7] = -(a*h - b*g) / det;
  inv[8] =  (a*e - b*d) / det;
  return inv;
}

/**
 * Reinhard Lab color transfer.
 * Transfers Lab mean+std from src to match target statistics.
 * Both mat and target must be BGR CV_8UC3.
 */
function reinhardNormalize(mat, targetStats) {
  const lab = new cv.Mat();
  cv.cvtColor(mat, lab, cv.COLOR_BGR2Lab);
  lab.convertTo(lab, cv.CV_32F);

  const channels = new cv.MatVector();
  cv.split(lab, channels);

  for (let c = 0; c < 3; c++) {
    const ch = channels.get(c);
    const meanStd = new cv.Mat();
    const meanMat = new cv.Mat();
    cv.meanStdDev(ch, meanMat, meanStd);
    const srcMean = meanMat.data64F[0];
    const srcStd  = meanStd.data64F[0] || 1;

    const tMean = targetStats.mean[c];
    const tStd  = targetStats.std[c];

    // (ch - srcMean) / srcStd * tStd + tMean
    cv.subtract(ch, new cv.Scalar(srcMean), ch);
    cv.multiply(ch, new cv.Scalar(tStd / srcStd), ch);
    cv.add(ch, new cv.Scalar(tMean), ch);

    meanMat.delete(); meanStd.delete();
  }

  const merged = new cv.Mat();
  cv.merge(channels, merged);
  channels.delete();
  lab.delete();

  merged.convertTo(merged, cv.CV_8U);
  const result = new cv.Mat();
  cv.cvtColor(merged, result, cv.COLOR_Lab2BGR);
  merged.delete();
  return result;
}

/**
 * Compute Reinhard Lab statistics from a mat.
 * Returns { mean: [L,a,b], std: [L,a,b] }.
 */
function computeLabStats(mat) {
  const lab = new cv.Mat();
  cv.cvtColor(mat, lab, cv.COLOR_BGR2Lab);
  lab.convertTo(lab, cv.CV_32F);

  const channels = new cv.MatVector();
  cv.split(lab, channels);

  const stats = { mean: [], std: [] };
  for (let c = 0; c < 3; c++) {
    const ch = channels.get(c);
    const meanMat = new cv.Mat();
    const stdMat  = new cv.Mat();
    cv.meanStdDev(ch, meanMat, stdMat);
    stats.mean.push(meanMat.data64F[0]);
    stats.std.push(stdMat.data64F[0]);
    meanMat.delete(); stdMat.delete();
  }

  channels.delete(); lab.delete();
  return stats;
}

/* ── Built-in reference statistics (pre-computed) ────────────── */

const BUILTIN_REF_STATS = {
  'builtin-he': {
    // Typical H&E scanner output Lab stats (0-255 OpenCV scale)
    mean: [168, 134, 126],
    std:  [28,  12,  10]
  },
  'builtin-ihk': {
    // IHC DAB+hematoxylin
    mean: [172, 133, 130],
    std:  [25,  10,  9]
  },
  'builtin-histo': {
    // General histochemistry
    mean: [165, 130, 128],
    std:  [30,  11,  11]
  }
};
