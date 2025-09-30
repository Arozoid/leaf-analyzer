// script.js — enhanced spinner, verdict + tips, color-box rendering
// (keeps your thresholds, rgbToHsv, analyzeCurrentCanvas, and bg-removal logic)

const THRESHOLD_HEALTHY = 60;   // >= this % => Healthy
const THRESHOLD_MODERATE = 35;  // >= this % => Moderately Healthy (else Unhealthy)

// DOM
const upload = document.getElementById("upload");
const analyzeBtn = document.getElementById("analyzeBtn");
const status = document.getElementById("status");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// spinner/progress and results placeholders (create fallback if missing)
let spinner = document.getElementById("spinner");
let spinnerText = spinner ? document.getElementById("spinnerText") : null;
let progressBar = document.getElementById("progressBar");
let progressWrap = document.getElementById("progressWrap");
let resultsContainer = document.getElementById("resultsContainer");
let verdictBox = document.getElementById("verdictBox");
let colorBox = document.getElementById("colorBox");
const resultsPlaceholder = document.getElementById("results"); // optional old area

// create spinner/progress/results if not present (robustness)
if (!spinner) {
  spinner = document.createElement("div");
  spinner.id = "spinner";
  spinner.className = "spinner";
  spinner.setAttribute("hidden", "true");
  spinner.innerHTML = '<div class="spinner-icon" aria-hidden="true"></div><div id="spinnerText">Processing…</div>';
  (document.body || document.documentElement).insertBefore(spinner, document.body.firstChild);
  spinnerText = document.getElementById("spinnerText");
}
if (!progressWrap) {
  progressWrap = document.createElement("div");
  progressWrap.id = "progressWrap";
  progressWrap.className = "progress-wrap";
  progressWrap.setAttribute("hidden", "true");
  progressBar = document.createElement("div");
  progressBar.id = "progressBar"; progressBar.className = "progress-bar";
  progressWrap.appendChild(progressBar);
  spinner.insertAdjacentElement("afterend", progressWrap);
}
if (!resultsContainer) {
  resultsContainer = document.createElement("div");
  resultsContainer.id = "resultsContainer";
  resultsContainer.className = "results-container";
  verdictBox = document.createElement("div"); verdictBox.id = "verdictBox"; verdictBox.className = "verdict-box";
  colorBox = document.createElement("aside"); colorBox.id = "colorBox"; colorBox.className = "color-box";
  resultsContainer.appendChild(verdictBox);
  resultsContainer.appendChild(colorBox);
  // append after canvas area (or to body)
  canvas.parentNode?.insertBefore(resultsContainer, canvas.nextSibling);
}

// internal
let processedDataURL = null;
let lastFile = null;

// Process uploaded file: try API, fallback to local removal
async function processFile(file) {
  lastFile = file;
  showSpinner("Removing background…");

  try {
    const apiDataURL = await callBgRemovalApi(file);
    await drawProcessedToCanvas(apiDataURL);
    hideSpinner("Background removed (API). Ready to analyze.");
  } catch (err) {
    console.warn("API failed, using local bg-removal fallback:", err);

    // fallback: draw original to offscreen canvas and remove by color
    const off = document.createElement("canvas");
    const offCtx = off.getContext("2d");

    await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
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

    const fallbackDataURL = removeBackgroundByColorFromCanvas(off, 50);
    await drawProcessedToCanvas(fallbackDataURL);

    hideSpinner("Background removed (local fallback). Ready to analyze.");
  }
}

/* ------------------------------------------------------------------
   Background removal helpers
   - removeBackgroundByColorFromCanvas(canvas, tolerance)
     -> expects an HTMLCanvasElement pre-drawn with the source image;
     -> returns a dataURL string (PNG) synchronously.

   - removeBackgroundByCanvas(input, tolerance)
     -> async. Accepts File | dataURL string | HTMLImageElement | HTMLCanvasElement
     -> returns a Promise resolving to a dataURL string (PNG)
   ------------------------------------------------------------------ */

function removeBackgroundByColorFromCanvas(offCanvas, tolerance = 45) {
  if (!(offCanvas instanceof HTMLCanvasElement)) {
    throw new Error('removeBackgroundByColorFromCanvas: expected a canvas element');
  }
  const w = offCanvas.width, h = offCanvas.height;
  const ctx = offCanvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Read pixels
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Helper: sample a small square patch and average its RGB
  function samplePatch(x0, y0, size = 10) {
    let r = 0, g = 0, b = 0, c = 0;
    const xEnd = Math.min(w, x0 + size), yEnd = Math.min(h, y0 + size);
    for (let y = Math.max(0, y0); y < yEnd; y++) {
      for (let x = Math.max(0, x0); x < xEnd; x++) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
    if (c === 0) return [0, 0, 0];
    return [r / c, g / c, b / c];
  }

  // Sample 4 corners
  const sA = samplePatch(0, 0);
  const sB = samplePatch(w - 10, 0);
  const sC = samplePatch(0, h - 10);
  const sD = samplePatch(w - 10, h - 10);
  const bgR = (sA[0] + sB[0] + sC[0] + sD[0]) / 4;
  const bgG = (sA[1] + sB[1] + sC[1] + sD[1]) / 4;
  const bgB = (sA[2] + sB[2] + sC[2] + sD[2]) / 4;

  // Remove pixels similar to bg color
  let removed = 0, kept = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < tolerance) {
      data[i + 3] = 0; // transparent
      removed++;
    } else {
      kept++;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const leafFraction = (kept / Math.max(1, w * h));

  // If the corner approach removed almost nothing or removed nearly everything,
  // treat as failure and fallback to color segmentation
  if (leafFraction < 0.005 || leafFraction > 0.95) {
    // perform color-based segmentation fallback
    const fallbackImg = ctx.getImageData(0, 0, w, h);
    const fdata = fallbackImg.data;
    let fKept = 0;
    for (let i = 0; i < fdata.length; i += 4) {
      const r = fdata[i], g = fdata[i + 1], b = fdata[i + 2];
      // convert to HSV (fast approx)
      const hsv = (function _rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const d = mx - mn;
        let h = 0, s = mx === 0 ? 0 : d / mx, v = mx;
        if (d !== 0) {
          switch (mx) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
          }
          h = h / 6 * 360;
        }
        return [h, s, v];
      })(r, g, b);

      const [hDeg, s, v] = hsv;
      // Leaf heuristic: green hues and reasonable saturation/value
      const isLeafColor = ((hDeg >= 50 && hDeg <= 200) && s >= 0.12 && v >= 0.06) ||
                          ((hDeg <= 40 || hDeg >= 320) && s >= 0.12 && v >= 0.06); // include red/purple variegation
      if (!isLeafColor) {
        fdata[i + 3] = 0;
      } else {
        fKept++;
      }
    }
    ctx.putImageData(fallbackImg, 0, 0);
    return offCanvas.toDataURL('image/png');
  }

  return offCanvas.toDataURL('image/png');
}

/**
 * removeBackgroundByCanvas(input, tolerance) -> Promise<dataURL>
 * input: File | dataURL string | HTMLImageElement | HTMLCanvasElement
 */
async function removeBackgroundByCanvas(input, tolerance = 45) {
  // Helper to create canvas from an image element
  function drawImageToCanvas(img) {
    const c = document.createElement('canvas');
    const maxDim = 1200; // keep sizes reasonable
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (w > maxDim || h > maxDim) {
      const ratio = w / h;
      if (ratio >= 1) { w = maxDim; h = Math.round(maxDim / ratio); }
      else { h = maxDim; w = Math.round(maxDim * ratio); }
    }
    c.width = w; c.height = h;
    const cctx = c.getContext('2d');
    // attempt to avoid taint for cross-origin images (best-effort)
    try { cctx.drawImage(img, 0, 0, w, h); } catch (e) { cctx.drawImage(img, 0, 0, w, h); }
    return c;
  }

  // If input is already a canvas, run directly
  if (input instanceof HTMLCanvasElement) {
    return removeBackgroundByColorFromCanvas(input, tolerance);
  }

  // If input is an Image element
  if (input instanceof HTMLImageElement) {
    const canvas = drawImageToCanvas(input);
    return removeBackgroundByColorFromCanvas(canvas, tolerance);
  }

  // If input is a File (from <input type="file">)
  if (input instanceof File) {
    // load file as object URL
    const url = URL.createObjectURL(input);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => { res(im); };
        im.onerror = (e) => { rej(new Error('Failed to load file as image')); };
        im.src = url;
      });
      const canvas = drawImageToCanvas(img);
      URL.revokeObjectURL(url);
      return removeBackgroundByColorFromCanvas(canvas, tolerance);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  // If input is a dataURL string (data:image/...)
  if (typeof input === 'string' && input.startsWith('data:')) {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = input;
    });
    const canvas = drawImageToCanvas(img);
    return removeBackgroundByColorFromCanvas(canvas, tolerance);
  }

  // If input is a URL string (http...), try to load it with crossOrigin 'anonymous'
  if (typeof input === 'string') {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = (e) => rej(new Error('Failed to load URL image (CORS or network)'));
      im.src = input;
    });
    const canvas = drawImageToCanvas(img);
    return removeBackgroundByColorFromCanvas(canvas, tolerance);
  }

  throw new Error('Unsupported input type for removeBackgroundByCanvas');
}

/**
 * Calls the API4AI background removal endpoint.
 * @param {string} imageUrl - The public URL of the image to process.
 * @returns {Promise<string>} - Resolves to a base64 dataURL (PNG with transparency).
 */
async function callingBgRemovalApi(imageUrl) {
  const formData = new FormData();
  formData.append("url", imageUrl);

  const response = await fetch(
    "https://demo.api4ai.cloud/img-bg-removal/v1/general/results",
    {
      method: "POST",
      body: formData
    }
  );

  if (!response.ok) {
    throw new Error("API request failed: " + response.statusText);
  }

  const data = await response.json();

  // Extract base64 image from API response
  const base64 = data.results[0].entities[0].image;
  return "data:image/png;base64," + base64;
}

// helpers
function setProgress(p = 0) {
  if (!progressBar) return;
  progressWrap.hidden = p <= 0;
  progressBar.style.width = `${Math.max(0, Math.min(100, p))}%`;
}
// --- Spinner helpers ---
function showSpinner(msg = "Processing…") {
  const overlay = document.getElementById("overlay");
  const text = document.getElementById("overlayText");
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
  if (text) text.textContent = msg;
  analyzeBtn.disabled = true;
}

function hideSpinner(msg = "") {
  const overlay = document.getElementById("overlay");
  const text = document.getElementById("overlayText");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
  if (msg) status.textContent = msg;
  analyzeBtn.disabled = false;
}

// note: keep your rgbToHsv function
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

// -------------------------------------------------------
// Insert your removeBackgroundByColorFromCanvas, drawProcessedToCanvas,
// callBgRemovalApi and processFile implementations here —
// for brevity, I'm assuming you already have them as posted earlier.
// -------------------------------------------------------
// To ensure completeness: re-use your existing implementations exactly as-is.
// For example:
// async function callBgRemovalApi(file) { ... }
// function removeBackgroundByColorFromCanvas(offCanvas, tolerance) { ... }
// async function processFile(file) { ... }
// async function drawProcessedToCanvas(dataURL) { ... }
// -------------------------------------------------------

// RENDER helpers
function makeColorItem(label, pct, count, hex) {
  // create DOM elements for a color row
  const row = document.createElement("div");
  row.className = "color-item";

  const sw = document.createElement("div");
  sw.className = "color-swatch";
  sw.style.background = hex;

  const labelWrap = document.createElement("div");
  labelWrap.style.minWidth = "110px";
  labelWrap.textContent = `${label}: ${pct.toFixed(1)}% (${count})`;

  const barWrap = document.createElement("div");
  barWrap.className = "color-bar";
  const barInner = document.createElement("div");
  barInner.className = "color-bar-inner";
  barInner.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  barInner.style.background = hex;
  barWrap.appendChild(barInner);

  row.appendChild(sw);
  row.appendChild(labelWrap);
  row.appendChild(barWrap);
  return row;
}

function generateTips(out) {
  const p = out.percents;
  const tips = [];

  if (out.verdict.includes("Healthy")) {
    tips.push("Looks healthy — continue similar light and watering. Monitor monthly for sudden changes.");
  } else if (out.verdict.includes("Moderately Healthy")) {
    tips.push("Some worry — check watering frequency and light exposure.");
    tips.push("Inspect yellow/brown patches and adjust watering or fertilizer accordingly.");
  } else if (out.verdict.includes("Unhealthy")) {
    tips.push("Unhealthy: inspect for pests, over/under-watering, or nutrient deficiencies.");
    tips.push("Consider moving plant to steadier light and test the soil moisture before watering again.");
  } else {
    tips.push("No leaf detected — try a clearer photo or ensure background removal worked.");
  }

  // targeted tips from color signals
  if (p.brownPct > 6) tips.push("Brown/dull areas are notable — could be sunburn, disease, or dehydration. Remove heavily damaged leaves and check airflow.");
  if (p.yellowPct > 6) tips.push("Yellowing suggests nutrient deficiency or overwatering — check soil moisture and consider a balanced fertilizer.");
  if ((p.redPct + p.purplePct) > 40) {
    tips.push("High red/purple percentage — if this is Coleus, that is likely natural variegation and not a sign of ill health.");
  }
  if (p.otherPct > 10) tips.push("Unclassified colors present — take a closer look or re-take photo under uniform lighting.");

  tips.push("These are heuristics — confirm with a teacher or plant diagnosis if unsure.");
  return tips;
}

function renderAnalysis(out) {
  // out: returned object from analyzeCurrentCanvas
  verdictBox.innerHTML = ""; // clear
  colorBox.innerHTML = "";   // clear

  // Left: verdict + tips
  const title = document.createElement("h3");
  title.textContent = out.verdict;

  const meta = document.createElement("div");
  meta.style.marginBottom = "8px";
  meta.textContent = `Leaf pixels analyzed: ${out.total}`;

  const tips = generateTips(out);
  const tipsList = document.createElement("ul");
  tipsList.style.margin = "6px 0 0 18px";
  tips.forEach(t => {
    const li = document.createElement("li");
    li.textContent = t;
    tipsList.appendChild(li);
  });

  verdictBox.appendChild(title);
  verdictBox.appendChild(meta);
  verdictBox.appendChild(tipsList);

  // Right: color swatches and percentages
  const p = out.percents;
  const counts = out.counts;
  const palette = [
    {k: 'green', name: 'Green', hex: '#2e7d32', pct: p.greenPct, cnt: counts.green},
    {k: 'red', name: 'Red', hex: '#c62828', pct: p.redPct, cnt: counts.red},
    {k: 'purple', name: 'Purple', hex: '#6a1b9a', pct: p.purplePct, cnt: counts.purple},
    {k: 'yellow', name: 'Yellow', hex: '#fbc02d', pct: p.yellowPct, cnt: counts.yellow},
    {k: 'brown', name: 'Brown', hex: '#8d6e63', pct: p.brownPct, cnt: counts.brown},
    {k: 'other', name: 'Other', hex: '#9e9e9e', pct: p.otherPct, cnt: counts.other}
  ];

  palette.forEach(col => {
    colorBox.appendChild(makeColorItem(col.name, col.pct || 0, col.cnt || 0, col.hex));
  });

  // show the container
  resultsContainer.hidden = false;
}

// ANALYZE wiring (assumes analyzeCurrentCanvas exists and returns expected output)
analyzeBtn.addEventListener("click", () => {
  showSpinner("Analyzing colors…");

  setTimeout(() => {
    const out = analyzeCurrentCanvas();
    if (!out) {
      hideSpinner("No image available");
      return;
    }

    const p = out.percents;

    // Generate tips based on verdict
    let tip = "";
    if (out.verdict.includes("Healthy")) {
      tip = " 🌱 Keep watering consistently, ensure good sunlight.";
    } else if (out.verdict.includes("Moderately")) {
      tip = " ⚠️ Watch for stress signs: adjust light/water and inspect for pests.";
    } else if (out.verdict.includes("Unhealthy")) {
      tip = " ❌ Consider pruning damaged leaves and improving soil or nutrients.";
    }

    // Build results HTML
    results.innerHTML = `
      <div class="results-box">
        <div class="verdict">
          <h2>${out.verdict}</h2>
          <p>${tip}</p>
          <p><small>Analyzed ${out.total} leaf pixels</small></p>
        </div>
        <div class="color-breakdown">
          <h3>Color Breakdown</h3>
          <ul>
            <li><span style="color:green;">●</span> Green: ${p.greenPct.toFixed(1)}%</li>
            <li><span style="color:red;">●</span> Red: ${p.redPct.toFixed(1)}%</li>
            <li><span style="color:purple;">●</span> Purple: ${p.purplePct.toFixed(1)}%</li>
            <li><span style="color:goldenrod;">●</span> Yellow: ${p.yellowPct.toFixed(1)}%</li>
            <li><span style="color:brown;">●</span> Brown/Dull: ${p.brownPct.toFixed(1)}%</li>
            <li><span style="color:gray;">●</span> Other: ${p.otherPct.toFixed(1)}%</li>
          </ul>
        </div>
      </div>
    `;

    hideSpinner("Analysis complete");
  }, 150);
});

// upload wiring (use your processFile implementation)
upload.addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  processedDataURL = null;
  analyzeBtn.disabled = true;
  resultsContainer.hidden = true;
  // call your processFile (which will show/hide spinner and set processedDataURL)
  try {
    await processFile(file); // your existing function that uses API / fallback and calls drawProcessedToCanvas
    // after processed, ensure analyze button enabled
    analyzeBtn.disabled = !processedDataURL;
  } catch (err) {
    console.error("Processing failed:", err);
    hideSpinner("Processing failed");
  }
});