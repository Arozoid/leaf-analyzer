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
function removeBackgroundByColorFromCanvas(offCanvas, tolerance = 45) {
  const w = offCanvas.width, h = offCanvas.height;
  const offCtx = offCanvas.getContext("2d");
  const imgData = offCtx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // average corner colors
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

  // remove background-ish pixels
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - bg[0], dg = data[i+1] - bg[1], db = data[i+2] - bg[2];
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    if (dist < tolerance) {
      data[i+3] = 0;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
  return offCanvas.toDataURL("image/png");
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
async function processFile(file) {
  lastFile = file;
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
    if (a < 16) continue;
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