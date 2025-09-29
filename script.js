/* script.js – Leaf Health Analyzer (with spinner + fixes) */

const upload = document.getElementById("upload");
const analyzeBtn = document.getElementById("analyzeBtn");
const resetBtn = document.getElementById("resetBtn");
const status = document.getElementById("status");
const results = document.getElementById("results");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlayText");

const BG_API_URL = "https://demo.api4ai.cloud/img-bg-removal/v1/general/results";
const MAX_DIM = 900; // max width/height for working canvas (reduces CPU & memory)

let currentImageDataURL = null; // what we drew on canvas (processed or fallback)

/* ---------- helpers ---------- */

function showOverlay(text = "Processing…") {
  overlayText.textContent = text;
  overlay.classList.remove("hidden");
  analyzeBtn.disabled = true;
  resetBtn.disabled = true;
  upload.disabled = true;
}
function hideOverlay() {
  overlay.classList.add("hidden");
  analyzeBtn.disabled = false;
  resetBtn.disabled = false;
  upload.disabled = false;
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error("Failed reading file"));
    fr.readAsDataURL(file);
  });
}

function loadImageToCanvas(img, maxDim = MAX_DIM) {
  // scale while preserving aspect ratio
  let w = img.width, h = img.height;
  if (Math.max(w, h) > maxDim) {
    const ratio = w / h;
    if (ratio >= 1) { w = maxDim; h = Math.round(maxDim / ratio); }
    else { h = maxDim; w = Math.round(maxDim * ratio); }
  }
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
}

/* RGB -> HSV helper (h: 0..360, s/v: 0..1) */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx;
  return [h, s, v];
}

/* ---------- background removal call ---------- */
async function callBgRemovalApi(file) {
  const form = new FormData();
  // api supports 'image' file or 'url' param; we send the file
  form.append("image", file);
  const resp = await fetch(BG_API_URL, { method: "POST", body: form });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("API error: " + resp.status + " — " + t.slice(0, 200));
  }
  const json = await resp.json();
  const base64 = json?.results?.[0]?.entities?.[0]?.image;
  if (!base64) throw new Error("Unexpected API response (no image).");
  return "data:image/png;base64," + base64;
}

/* ---------- UI flow ---------- */

upload.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  status.textContent = "⏳ Removing background (API)…";
  showOverlay("Removing background…");

  try {
    // Try API first
    const processedDataUrl = await callBgRemovalApi(file);
    // draw processed image
    const img = new Image();
    img.onload = () => {
      loadImageToCanvas(img);
      currentImageDataURL = processedDataUrl;
      status.textContent = "✅ Background removed. Click Analyze.";
      results.textContent = "Ready to analyze.";
      analyzeBtn.disabled = false;
      resetBtn.disabled = false;
      hideOverlay();
    };
    img.onerror = (err) => {
      throw new Error("Processed image failed to load.");
    };
    img.src = processedDataUrl;

  } catch (err) {
    console.warn("BG API failed:", err);
    // Fallback: load the original file (no bg removal)
    status.textContent = "⚠️ API failed — using original image (no background removal).";
    try {
      const originalDataUrl = await readFileAsDataURL(file);
      const img = new Image();
      img.onload = () => {
        loadImageToCanvas(img);
        currentImageDataURL = originalDataUrl;
        status.textContent = "✅ Original image loaded. Click Analyze (note: background not removed).";
        results.textContent = "Ready to analyze (no background removal).";
        analyzeBtn.disabled = false;
        resetBtn.disabled = false;
        hideOverlay();
      };
      img.onerror = () => {
        status.textContent = "❌ Failed to load image.";
        hideOverlay();
      };
      img.src = originalDataUrl;
    } catch (readErr) {
      status.textContent = "❌ Failed to load original image.";
      hideOverlay();
    }
  }
});

/* ---------- Analysis ---------- */
analyzeBtn.addEventListener("click", () => {
  showOverlay("Analyzing leaf…");
  status.textContent = "🔍 Analyzing leaf…";
  results.textContent = "";

  // get pixel data
  try {
    const w = canvas.width, h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h).data;
    let total = 0, green = 0, yellow = 0;

    for (let i = 0; i < imgData.length; i += 4) {
      const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2], a = imgData[i + 3];
      // ignore transparent / nearly transparent pixels (alpha)
      if (typeof a === "number" && a < 16) continue;
      total++;
      // HSV-based check for green (robust)
      const [hue, sat, val] = rgbToHsv(r, g, b);
      // Green: hue roughly 60–160, saturation and value not too low
      if ((hue >= 60 && hue <= 160) && sat >= 0.12 && val >= 0.10) { green++; }
      // Yellow / brown heuristic
      else if ((hue >= 10 && hue <= 65) && sat >= 0.06 && val >= 0.06) { yellow++; }
      // fallback: simple dominance (for odd cases)
      else if (g > r + 18 && g > b + 18) green++;
    }

    if (total === 0) {
      results.textContent = "No leaf pixels detected (image may be empty or fully transparent).";
      status.textContent = "⚠️ No leaf detected.";
      hideOverlay();
      return;
    }

    const greenPct = (green / total) * 100;
    const yellowPct = (yellow / total) * 100;

    // decide health
    let health = "Unhealthy / stressed ❌";
    if (greenPct >= 70) health = "Healthy ✅";
    else if (greenPct >= 40) health = "Moderately healthy ⚠️";
    else if (yellowPct > greenPct && yellowPct > 25) health = "Likely chlorosis / nutrient stress ⚠️";

    results.innerHTML = `
      Green coverage: <strong>${greenPct.toFixed(2)}%</strong><br/>
      Yellow/brown coverage: <strong>${yellowPct.toFixed(2)}%</strong><br/>
      Total leaf pixels analyzed: <strong>${total.toLocaleString()}</strong><br/>
      <div style="margin-top:8px">Overall: <span style="font-weight:900">${health}</span></div>
    `;

    status.textContent = "✨ Analysis complete!";
    hideOverlay();
  } catch (err) {
    console.error("Analysis failed:", err);
    status.textContent = "❌ Analysis failed.";
    results.textContent = "Analysis error — check console.";
    hideOverlay();
  }
});

/* ---------- Reset ---------- */
resetBtn.addEventListener("click", () => {
  // clear canvas & UI
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
  upload.value = "";
  analyzeBtn.disabled = true;
  resetBtn.disabled = true;
  currentImageDataURL = null;
  status.textContent = "Waiting for upload...";
  results.textContent = "No analysis yet.";
});