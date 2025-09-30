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

function rgbToHsv(r, g,