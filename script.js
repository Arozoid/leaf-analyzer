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
  const mx = Math.max
