// =======================
// Configurable thresholds
// =======================
const THRESHOLD_HEALTHY = 60;   // >= this % => Healthy
const THRESHOLD_MODERATE = 35;  // >= this % => Moderately Healthy
const THRESHOLD_MODERATE_ALT = 20; // unhealthyPct >= this % => Moderately Healthy
const THRESHOLD_UNHEALTHY = 40;

// ===========
// DOM targets
// ===========
const upload = document.getElementById("upload");
const analyzeBtn = document.getElementById("analyzeBtn");
const results = document.getElementById("results");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// Overlay spinner
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlayText");

// internal state
let processedDataURL = null;
let lastFile = null;

// ===================
// Spinner helpers
// ===================
function showSpinner(msg = "Processing…") {
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
  if (overlayText) overlayText.textContent = msg;
  if (analyzeBtn) analyzeBtn.disabled = true;
}

function hideSpinner(msg = "") {
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
  if (overlayText) overlayText.textContent = msg;
  if (analyzeBtn) analyzeBtn.disabled = false;
}

// =============================
// Color conversion helper (RGB→HSV)
// =============================
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, v];
}

// ===================================
// Local fallback background removal
// ===================================
function removeBackgroundByColorFromCanvas(offCanvas, opts = {}) {
  // opts: { toleranceMult, minThresh, maxThresh, sampleStep, morphIter }
  const cfg = Object.assign({
    toleranceMult: 1.1,
    minThresh: 8,
    maxThresh: 60,
    sampleStep: 6,    // sampling spacing along borders
    morphIter: 2,     // number of erosion/dilation iterations
    keepComponentMinPx: 25 // minimum pixels for the largest component to be considered valid
  }, opts);

  const w = offCanvas.width, h = offCanvas.height;
  const ctx = offCanvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // ---- helper: sRGB -> Lab conversion (for perceptual distance) ----
  function rgbToLab(r, g, b) {
    // convert to 0..1 linear
    function srgbToLin(c){ c /= 255; return (c <= 0.04045) ? c / 12.92 : Math.pow((c + 0.055)/1.055, 2.4); }
    const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
    // sRGB -> XYZ (D65)
    const X = R*0.4124564 + G*0.3575761 + B*0.1804375;
    const Y = R*0.2126729 + G*0.7151522 + B*0.0721750;
    const Z = R*0.0193339 + G*0.1191920 + B*0.9503041;
    // normalize by reference white
    const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
    function f(t){ return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16/116); }
    const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
    const L = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const b2 = 200 * (fy - fz);
    return [L, a, b2];
  }

  function deltaE(lab1, lab2) {
    const dL = lab1[0] - lab2[0];
    const da = lab1[1] - lab2[1];
    const db = lab1[2] - lab2[2];
    return Math.sqrt(dL*dL + da*da + db*db);
  }

  // ---- sample many border pixels (top/bottom/left/right) ----
  const samples = [];
  const step = Math.max(1, Math.floor(cfg.sampleStep));
  for (let x = 0; x < w; x += step) {
    let iTop = (0 * w + x) * 4;
    let iBot = ((h - 1) * w + x) * 4;
    samples.push(rgbToLab(data[iTop], data[iTop+1], data[iTop+2]));
    samples.push(rgbToLab(data[iBot], data[iBot+1], data[iBot+2]));
  }
  for (let y = 0; y < h; y += step) {
    let iL = (y * w + 0) * 4;
    let iR = (y * w + (w-1)) * 4;
    samples.push(rgbToLab(data[iL], data[iL+1], data[iL+2]));
    samples.push(rgbToLab(data[iR], data[iR+1], data[iR+2]));
  }

  // compute mean Lab of border samples
  let sumL=0, suma=0, sumb=0;
  for (const s of samples) { sumL += s[0]; suma += s[1]; sumb += s[2]; }
  const meanLab = [sumL/samples.length, suma/samples.length, sumb/samples.length];

  // compute distance stats on border samples to adapt threshold
  const dists = samples.map(s => deltaE(s, meanLab));
  const meanDist = dists.reduce((a,b)=>a+b,0) / dists.length;
  const sq = dists.map(d => (d - meanDist)*(d - meanDist));
  const std = Math.sqrt(sq.reduce((a,b)=>a+b,0) / dists.length);

  // adaptive threshold (in Lab space) - perceptually meaningful
  const thresh = Math.max(cfg.minThresh, Math.min(cfg.maxThresh, meanDist + cfg.toleranceMult * std));

  // ---- helper: impossible color filter (reuse your existing heuristic but with HSV) ----
  function isImpossibleLeafColor(r,g,b) {
    const [hDeg, s, v] = rgbToHsv(r,g,b);
    if (v > 0.95 && s < 0.12) return true; // near white
    if (v < 0.06 && s < 0.12) return true;  // near black
    if (s < 0.06 && v >= 0.06 && v <= 0.94) return true; // neutral grays
    // blues/cyans
    if (hDeg >= 180 && hDeg <= 260 && s > 0.12) return true;
    return false;
  }

  // ---- create initial mask: 1 = candidate leaf, 0 = background ----
  const mask = new Uint8Array(w * h);
  const labCache = new Float32Array(w * h * 3); // cache lab values for speed
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 8) { mask[p] = 0; labCache[p*3] = labCache[p*3+1] = labCache[p*3+2] = 0; continue; }
      if (isImpossibleLeafColor(r,g,b)) { mask[p] = 0; labCache[p*3] = labCache[p*3+1] = labCache[p*3+2] = 0; continue; }
      const lab = rgbToLab(r,g,b);
      labCache[p*3] = lab[0]; labCache[p*3+1] = lab[1]; labCache[p*3+2] = lab[2];
      const d = deltaE(lab, meanLab);
      // mark as leaf candidate when distance > threshold
      mask[p] = d > thresh ? 1 : 0;
    }
  }

  // ---- morphological clean-up: erode then dilate (opening) ----
  function erode(m, w, h) {
    const out = new Uint8Array(m.length);
    for (let y=0, idx=0; y<h; y++) {
      for (let x=0; x<w; x++, idx++) {
        if (m[idx] === 0) { out[idx] = 0; continue; }
        // check 8 neighbors, if any neighbor 0 -> set 0
        let all = 1;
        for (let yy=-1; yy<=1; yy++) {
          const ny = y + yy;
          if (ny < 0 || ny >= h) { all = 0; break; }
          for (let xx=-1; xx<=1; xx++) {
            const nx = x + xx;
            if (nx < 0 || nx >= w) { all = 0; break; }
            const nidx = ny*w + nx;
            if (m[nidx] === 0) { all = 0; break; }
          }
          if (!all) break;
        }
        out[idx] = all ? 1 : 0;
      }
    }
    return out;
  }
  function dilate(m, w, h) {
    const out = new Uint8Array(m.length);
    for (let y=0, idx=0; y<h; y++) {
      for (let x=0; x<w; x++, idx++) {
        if (m[idx] === 1) { out[idx] = 1; continue; }
        let any = 0;
        for (let yy=-1; yy<=1; yy++) {
          const ny = y + yy; if (ny < 0 || ny >= h) continue;
          for (let xx=-1; xx<=1; xx++) {
            const nx = x + xx; if (nx < 0 || nx >= w) continue;
            const nidx = ny*w + nx;
            if (m[nidx] === 1) { any = 1; break; }
          }
          if (any) break;
        }
        out[idx] = any ? 1 : 0;
      }
    }
    return out;
  }

  let cleaned = mask;
  for (let it=0; it<cfg.morphIter; it++) cleaned = erode(cleaned, w, h);
  for (let it=0; it<cfg.morphIter; it++) cleaned = dilate(cleaned, w, h);

  // ---- keep largest connected component only ----
  const labels = new Int32Array(w*h);
  let curLabel = 1;
  let largestLabel = 0, largestSize = 0;
  const stack = [];
  for (let p=0; p < w*h; p++) {
    if (cleaned[p] === 1 && labels[p] === 0) {
      // flood fill / BFS
      let size = 0;
      stack.push(p);
      labels[p] = curLabel;
      while (stack.length) {
        const q = stack.pop();
        size++;
        const y = Math.floor(q / w), x = q - y*w;
        // 4-neighbors (faster)
        const neighbors = [ [x+1,y], [x-1,y], [x,y+1], [x,y-1] ];
        for (const [nx,ny] of neighbors) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (cleaned[ni] === 1 && labels[ni] === 0) {
            labels[ni] = curLabel;
            stack.push(ni);
          }
        }
      }
      if (size > largestSize) { largestSize = size; largestLabel = curLabel; }
      curLabel++;
    }
  }

  // if largest component is tiny, avoid throwing everything away; keep original cleaned mask in that case
  let finalMask = new Uint8Array(w*h);
  if (largestSize >= cfg.keepComponentMinPx) {
    for (let p=0; p<w*h; p++) finalMask[p] = (labels[p] === largestLabel) ? 1 : 0;
  } else {
    // fallback: use cleaned mask but try to remove isolated pixels with one more opening
    finalMask = cleaned;
  }

  // ---- feather edges: average 3x3 neighborhood to produce soft alpha ----
  const alphaArr = new Uint8ClampedArray(w*h);
  for (let y=0, idx=0; y<h; y++) {
    for (let x=0; x<w; x++, idx++) {
      let sum = 0, count = 0;
      for (let yy = -1; yy <= 1; yy++) {
        const ny = y + yy; if (ny < 0 || ny >= h) continue;
        for (let xx = -1; xx <= 1; xx++) {
          const nx = x + xx; if (nx < 0 || nx >= w) continue;
          sum += finalMask[ny*w + nx];
          count++;
        }
      }
      const frac = count ? (sum / count) : 0;
      alphaArr[idx] = Math.round(frac * 255);
    }
  }

  // apply alpha back to imageData
  for (let p = 0, i = 0; p < w*h; p++, i += 4) {
    const a = alphaArr[p];
    // preserve some original alpha if semi-transparent
    if (a < 16) {
      data[i+3] = 0;
    } else {
      data[i+3] = a;
    }
  }

  // write back and return dataURL PNG
  ctx.putImageData(imgData, 0, 0);
  return offCanvas.toDataURL('image/png');
}

// =========================
// API background removal
// =========================
const BG_API_URL = "https://demo.api4ai.cloud/img-bg-removal/v1/general/results";

async function callBgRemovalAPI(input) {
  const form = new FormData();
  if (input instanceof File) form.append("image", input);
  else form.append("url", input);

  const resp = await fetch(BG_API_URL, { method: "POST", body: form });
  if (!resp.ok) throw new Error("API error " + resp.status);
  const json = await resp.json();
  const base64 = json?.results?.[0]?.entities?.[0]?.image;
  if (!base64) throw new Error("API gave no image");
  return "data:image/png;base64," + base64;
}

// =============================
// Draw processed image to canvas
// =============================
function drawProcessedToCanvas(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1000;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = w/h;
        if (ratio >= 1) { w = maxDim; h = Math.round(maxDim / ratio); }
        else { h = maxDim; w = Math.round(maxDim * ratio); }
      }
      canvas.width = w; canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      processedDataURL = canvas.toDataURL("image/png");
      resolve();
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ==========================
// Process file (API + local)
// ==========================
const bgRemovalToggle = document.getElementById("bgRemovalToggle");

async function processFile(file) {
  lastFile = file;

  if (bgRemovalToggle && !bgRemovalToggle.checked) {
    // 🚫 Skip background removal
    showSpinner("Loading image without background removal…");
    const dataURL = URL.createObjectURL(file);
    await drawProcessedToCanvas(dataURL);
    hideSpinner("Image loaded");
    return;
  }

  showSpinner("Removing background…");
  try {
    const apiDataURL = await callBgRemovalAPI(file);
    await drawProcessedToCanvas(apiDataURL);
    hideSpinner("Background removed (API). Ready to analyze.");
  } catch (err) {
    console.warn("API failed, fallback:", err);
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        off.width = img.width; off.height = img.height;
        offCtx.drawImage(img, 0, 0);
        res();
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
    const fallbackDataURL = removeBackgroundByColorFromCanvas(off, 50);
    await drawProcessedToCanvas(fallbackDataURL);
    hideSpinner("Background removed (local fallback). Ready to analyze.");
  }
}

// ==================================================
// Helper: filter colors that can't belong to a leaf
// ==================================================
function isImpossibleLeafColor(r, g, b) {
  const [hDeg, s, v] = rgbToHsv(r, g, b);

  // Very light (white-ish / bright gray)
  if (v > 0.9 && s < 0.1) return true;

  // Very dark gray/black
  if (v < 0.1 && s < 0.1) return true;

  // Neutral gray midtones
  if (s < 0.08 && v >= 0.1 && v <= 0.9) return true;

  // Pure blues & cyans (not in leaves normally)
  if (hDeg >= 180 && hDeg <= 260 && s > 0.1) return true;

  return false;
}

// =====================
// Analyze leaf colors
// =====================
function analyzeCurrentCanvas() {
  if (!processedDataURL) return null;
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  let total = 0, green=0, red=0, purple=0, yellow=0, brown=0, other=0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a < 16) continue; // transparent skip
    if (isImpossibleLeafColor(r, g, b)) continue; // 🚀 new filter
    total++;
    const [hDeg, s, v] = rgbToHsv(r,g,b);

    if (s < 0.18 && v < 0.45) { brown++; continue; }
    if (hDeg >= 60 && hDeg <= 180 && s >= 0.2) { green++; continue; }
    if ((hDeg <= 30 || hDeg >= 330) && s >= 0.18) { red++; continue; }
    if (hDeg >= 260 && hDeg <= 320 && s >= 0.15) { purple++; continue; }
    if (hDeg >= 30 && hDeg < 60 && s >= 0.18) { yellow++; continue; }
    other++;
  }

  const healthyCount = green+red+purple;
  const healthyPct = total ? (healthyCount/total)*100 : 0;

  const unhealthyCount = yellow+brown+other;
  const unhealthyPct = total ? (unhealthyCount/total)*100 : 0;

  let verdict = "No leaf detected";
  let tips = "";
  if (total >= 50) {
    if (healthyPct >= THRESHOLD_HEALTHY && unhealthyPct < THRESHOLD_MODERATE_ALT) {
      verdict = "Healthy ✅";
      tips = "Leaf pigments look strong and balanced.";
    } else if (healthyPct >= THRESHOLD_MODERATE || unhealthyPct >= THRESHOLD_MODERATE_ALT && unhealthyPct < THRESHOLD_UNHEALTHY) {
      verdict = "Moderately Healthy ⚠️";
      tips = "Monitor watering and sunlight. Some stress signs.";
    } else {
      verdict = "Unhealthy ❌";
      tips = "Signs of stress/disease. Consider checking soil, pests, or light.";
    }
  }

  return {
    total,
    counts: {green, red, purple, yellow, brown, other},
    percents: {
      greenPct: (green/total)*100 || 0,
      redPct: (red/total)*100 || 0,
      purplePct: (purple/total)*100 || 0,
      yellowPct: (yellow/total)*100 || 0,
      brownPct: (brown/total)*100 || 0,
      otherPct: (other/total)*100 || 0,
      healthyPct
    },
    verdict, tips
  };
}

// ====================
// Event wiring
// ====================
upload.addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  processedDataURL = null;
  results.textContent = "";
  analyzeBtn.disabled = true;
  await processFile(file);
  analyzeBtn.disabled = false;
});

analyzeBtn.addEventListener("click", () => {
  showSpinner("Analyzing leaf…");
  setTimeout(() => {
    const out = analyzeCurrentCanvas();
    hideSpinner("");
    if (!out) {
      results.textContent = "No image to analyze.";
      return;
    }
    const p = out.percents;
    results.innerHTML = `
      <div style="display:flex;gap:1rem;align-items:flex-start;">
        <div style="flex:1; padding:0.5rem; border:1px solid #ccc; border-radius:8px;">
          <strong>Verdict:</strong> ${out.verdict}<br>
          <em>${out.tips}</em><br>
          <small>Analyzed ${out.total} pixels</small>
        </div>
        <div style="flex:1;">
          <strong>Color breakdown:</strong><br>
          Green: ${p.greenPct.toFixed(1)}%<br>
          Red: ${p.redPct.toFixed(1)}%<br>
          Purple: ${p.purplePct.toFixed(1)}%<br>
          Yellow: ${p.yellowPct.toFixed(1)}%<br>
          Brown: ${p.brownPct.toFixed(1)}%<br>
          Other: ${p.otherPct.toFixed(1)}%
        </div>
      </div>
    `;
  }, 150);
});