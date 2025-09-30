const upload = document.getElementById("upload");
const analyzeBtn = document.getElementById("analyzeBtn");
const status = document.getElementById("status");
const results = document.getElementById("results");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let leafImage = null;

/* Convert RGB → HSV (Hue [0–360], Sat [0–1], Val [0–1]) */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;

  if (max === min) {
    h = 0;
  } else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, v]; // Hue in degrees
}

/* Analyze leaf pixels */
function analyzeLeaf(imgData) {
  let healthy = 0, unhealthy = 0, total = imgData.length / 4;

  for (let i = 0; i < imgData.length; i += 4) {
    const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2], a = imgData[i + 3];
    if (a === 0) continue; // skip transparent background

    const [h, s, v] = rgbToHsv(r, g, b);

    if (s < 0.2 || v < 0.2) {
      // very gray/black pixel → unhealthy
      unhealthy++;
    } else if (
      (h >= 60 && h <= 180) ||    // green
      (h <= 20 || h >= 160) ||   // red
      (h >= 260 && h <= 320)     // purple/pink
    ) {
      healthy++;
    } else {
      unhealthy++;
    }
  }

  const healthyRatio = (healthy / total) * 100;
  const unhealthyRatio = (unhealthy / total) * 100;

  return {
    healthyRatio,
    unhealthyRatio,
    verdict: healthyRatio > 60 ? "Healthy ✅" :
             healthyRatio > 40 ? "Moderately Healthy ⚠️" :
             "Unhealthy ❌"
  };
}

// Step 1. Upload → Background Removal API
upload.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  status.textContent = "Processing image...";
  analyzeBtn.disabled = true;

  const formData = new FormData();
  formData.append("image", file);

  try {
    const response = await fetch(
      "https://demo.api4ai.cloud/img-bg-removal/v1/general/results",
      { method: "POST", body: formData }
    );

    const data = await response.json();
    const base64 = data.results[0].entities[0].image;
    const imgSrc = "data:image/png;base64," + base64;

    leafImage = new Image();
    leafImage.onload = () => {
      canvas.width = leafImage.width;
      canvas.height = leafImage.height;
      ctx.drawImage(leafImage, 0, 0);
      status.textContent = "Leaf ready! Click Analyze.";
      analyzeBtn.disabled = false;
    };
    leafImage.src = imgSrc;

  } catch (err) {
    console.error(err);
    status.textContent = "Error: Could not process image.";
  }
});

// Step 2. Analyze leaf colors
analyzeBtn.addEventListener("click", () => {
  if (!leafImage) return;

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const { healthyRatio, unhealthyRatio, verdict } = analyzeLeaf(imgData);

  results.textContent =
    `Healthy Colors: ${healthyRatio.toFixed(2)}% | ` +
    `Unhealthy: ${unhealthyRatio.toFixed(2)}% → ${verdict}`;
});