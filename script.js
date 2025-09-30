// script.js — fixed totals, spinner, color breakdown for Coleus (green/red/purple),
// API background removal with local fallback, and clearer verdict thresholds.

// --- Configurable thresholds ---
const THRESHOLD_HEALTHY = 60;   // >= this % => Healthy
const THRESHOLD_MODERATE = 35;  // >= this % => Moderately Healthy (else Unhealthy)

// --- DOM ---
const upload = document.getElementById("upload");
const analyzeBtn = document.getElementById("analyzeBtn");
const status = document.getElementById("status");
const results = document.getElementById("results");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// optional spinner/progress elements (add to HTML if not present)
const spinner = document.getElementById("spinner");   // <div id="spinner"></div> (CSS below)
const progressBar = document.getElementById("progressBar"); // optional

// internal
let processedDataURL = null; // dataURL of processed image (with transparency)
let lastFile = null;

// === helpers ===
function showSpinner(msg = "Processing…") {
  if (spinner) spinner.hidden = false;
  if (progressBar) progressBar.style.width = "10%";
  status.textContent = msg;
  analyzeBtn.disabled = true;
}
function setProgress(p) { if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, p))}%`; }
function hideSpinner(msg = "") {
  if (spinner) spinner.hidden = true;
  if (progressBar) progressBar.style.width = "0%";
  status.textContent = msg;
  analyzeBtn.disabled = false;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    switch(max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, v];
}

// Local fallback bg removal: sample corners and set nearby colors transparent
function removeBackgroundByColorFromCanvas(offCanvas, tolerance = 45) {
  const w = offCanvas.width, h = offCanvas.height;
  const offCtx = offCanvas.getContext("2d");
  const imgData = offCtx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // sample four 10x10 corner patches to estimate background color
  function samplePatch(x0, y0, size = 10) {
    let r=0,g=0,b=0,c=0;
    for (let y=y0; y<Math.min(y0+size,h); y++) {
      for (let x=x0; x<Math.min(x0+size,w); x++) {
        const i = (y*w + x)*4;
        r += data[i]; g += data[i+1]; b += data[i+2]; c++;
      }
    }
    return [r/c, g/c, b/c];
  }
  const s1 = samplePatch(0,0), s2 = samplePatch(w-10,0), s3 = samplePatch(0,h-10), s4 = samplePatch(w-10,h-10);
  const bg = [(s1[0]+s2[0]+s3[0]+s4[0])/4, (s1[1]+s2[1]+s3[1]+s4[1])/4, (s1[2]+s2[2]+s3[2]+s4[2])/4];

  // mark pixels similar to bg as transparent
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - bg[0], dg = data[i+1] - bg[1], db = data[i+2] - bg[2];
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    if (dist < tolerance) {
      data[i+3] = 0; // alpha -> transparent
    }
  }
  offCtx.putImageData(imgData, 0, 0);
  return offCanvas.toDataURL("image/png");
}

// Draw dataURL onto main canvas and store processedDataURL
function drawProcessedToCanvas(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // scale down if huge to keep analysis quick
      const maxDim = 1000;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = w / h;
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

// Call the demo API; returns dataURL (PNG with transparency)
async function callBgRemovalApi(file) {
  const form = new FormData();
  form.append("image", file);
  const API = "https://demo.api4ai.cloud/img-bg-removal/v1/general/results";
  const resp = await fetch(API, { method: "POST", body: form });
  if (!resp.ok) throw new Error("API error: " + resp.status);
  const json = await resp.json();
  const base64 = json?.results?.[0]?.entities?.[0]?.image;
  if (!base64) throw new Error("API returned no image");
  return "data:image/png;base64," + base64;
}

// Process uploaded file: try API, fallback to local removal
async function processFile(file) {
  lastFile = file;
  showSpinner("Removing background…");
  try {
    setProgress(12);
    const apiDataURL = await callBgRemovalApi(file);
    setProgress(70);
    await drawProcessedToCanvas(apiDataURL);
    setProgress(100);
    hideSpinner("Background removed (API). Ready to analyze.");
  } catch (err) {
    console.warn("API failed, using local bg-removal fallback:", err);
    // fallback: draw original to offscreen canvas and remove by color
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");
    // load image into off-canvas
    await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        // scale similar to drawProcessedToCanvas
        const maxDim = 1000;
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = w / h;
          if (ratio >= 1) { w = maxDim; h = Math.round(maxDim / ratio); }
          else { h = maxDim; w = Math.round(maxDim * ratio); }
        }
        off.width = w; off.height = h;
        offCtx.drawImage(img, 0, 0, w, h);
        res();
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
    setProgress(50);
    const fallbackDataURL = removeBackgroundByColorFromCanvas(off, 50);
    await drawProcessedToCanvas(fallbackDataURL);
    setProgress(100);
    hideSpinner("Background removed (local fallback). Ready to analyze.");
  }
}

/* Main analyze function — returns breakdown & verdict */
function analyzeCurrentCanvas() {
  if (!processedDataURL) return null;
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  let total = 0;
  let green = 0, red = 0, purple = 0, yellow = 0, brown = 0, other = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    // skip transparent / background pixels
    if (typeof a !== "undefined" && a < 16) continue;
    total++;

    const [hDeg, s, v] = rgbToHsv(r, g, b);

    // heuristics (tuned for leaf pigments, Coleus variegation)
    // brown/dull: low saturation and low value
    if (s < 0.18 && v < 0.45) {
      brown++; continue;
    }
    // green
    if (hDeg >= 60 && hDeg <= 180 && s >= 0.2 && v >= 0.15) { green++; continue; }
    // red (wrap at 360)
    if ((hDeg <= 30 || hDeg >= 330) && s >= 0.18 && v >= 0.12) { red++; continue; }
    // purple/pink
    if (hDeg >= 260 && hDeg <= 320 && s >= 0.15) { purple++; continue; }
    // yellow (can be healthy in some varieties but often indicates stress)
    if (hDeg >= 30 && hDeg < 60 && s >= 0.18) { yellow++; continue; }

    other++;
  }

  const healthyCount = green + red + purple; // treat these pigments as 'healthy colors'
  const unhealthyCount = brown + other;     // explicit brown/dull + misc unknown => unhealthy
  const healthyPct = total ? (healthyCount / total) * 100 : 0;
  const unhealthyPct = total ? (unhealthyCount / total) * 100 : 0;

  // verdict using user-friendly thresholds (configurable up top)
  let verdict = "No leaf detected";
  if (total >= 50) {
    if (healthyPct >= THRESHOLD_HEALTHY) verdict = "Healthy ✅";
    else if (healthyPct >= THRESHOLD_MODERATE) verdict = "Moderately Healthy ⚠️";
    else verdict = "Unhealthy ❌";
  }

  return {
    total,
    counts: { green, red, purple, yellow, brown, other },
    percents: {
      healthyPct, unhealthyPct,
      greenPct: total ? (green/total)*100 : 0,
      redPct: total ? (red/total)*100 : 0,
      purplePct: total ? (purple/total)*100 : 0,
      yellowPct: total ? (yellow/total)*100 : 0,
      brownPct: total ? (brown/total)*100 : 0,
      otherPct: total ? (other/total)*100 : 0
    },
    verdict
  };
}

// === Event wiring ===
upload.addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  processedDataURL = null;
  analyzeBtn.disabled = true;
  results.textContent = "";
  await processFile(file);
});

analyzeBtn.addEventListener("click", () => {
  showSpinner("Analyzing colors…");
  setTimeout(() => { // minor delay so spinner shows on slow devices
    const out = analyzeCurrentCanvas();
    if (!out) {
      hideSpinner("No image available");
      return;
    }
    // show detailed breakdown
    const p = out.percents;
    const txt = `
      Verdict: ${out.verdict}
      (Leaf pixels analyzed: ${out.total})
      Healthy colors (green/red/purple): ${p.healthyPct.toFixed(1)}%
      • green ${p.greenPct.toFixed(1)}% • red ${p.redPct.toFixed(1)}% • purple ${p.purplePct.toFixed(1)}%
      Yellow: ${p.yellowPct.toFixed(1)}%  • Brown/dull: ${p.brownPct.toFixed(1)}%  • Other: ${p.otherPct.toFixed(1)}%
    `;
    results.textContent = txt.replace(/\s+/g,' ').trim();
    hideSpinner("Analysis complete");
  }, 150);
});