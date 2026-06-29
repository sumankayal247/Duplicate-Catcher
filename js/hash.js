// Content hashing: exact (SHA-256 of bytes) + perceptual (dHash of pixels).
// Filenames are never used — detection is purely content based.
// Wrapped in an IIFE so only window.DC_hash leaks — no global name clashes.

(function () {
// ---- Exact: SHA-256 of the raw file bytes --------------------------------
async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Perceptual: 64-bit difference hash (dHash) --------------------------
// Scale source to 9x8 grayscale, compare adjacent pixels per row -> 64 bits.
// Robust to resizing, recompression and minor edits.
function dHash(drawable) {
  const W = 9;
  const H = 8;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(drawable, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;

  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  let hash = 0n;
  let pos = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (gray[y * W + x] > gray[y * W + x + 1]) hash |= 1n << pos;
      pos++;
    }
  }
  return hash; // BigInt, 64 significant bits
}

function hamming(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

// ---- Image perceptual hash ----------------------------------------------
async function imagePHash(file) {
  const bmp = await createImageBitmap(file);
  try {
    return { kind: 'img', frames: [dHash(bmp)] };
  } finally {
    if (bmp.close) bmp.close();
  }
}

// ---- Video perceptual hash (sample a few frames) ------------------------
function videoPHash(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.src = url;

    const frames = [];
    let times = [];
    let idx = 0;
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(val);
    };
    const timer = setTimeout(() => finish(frames.length ? { kind: 'vid', frames } : null), 20000);

    v.onerror = () => finish(frames.length ? { kind: 'vid', frames } : null);

    v.onloadeddata = () => {
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const raw = dur > 0 ? [dur * 0.15, dur * 0.45, dur * 0.75] : [0];
      times = [...new Set(raw.map((t) => +Math.max(0, t).toFixed(2)))];
      seekNext();
    };

    function seekNext() {
      if (idx >= times.length) {
        return finish(frames.length ? { kind: 'vid', frames } : null);
      }
      try {
        v.currentTime = times[idx];
      } catch (e) {
        finish(frames.length ? { kind: 'vid', frames } : null);
      }
    }

    v.onseeked = () => {
      try {
        frames.push(dHash(v));
      } catch (e) {
        /* tainted/undecodable frame — skip */
      }
      idx++;
      seekNext();
    };
  });
}

// ---- Distance between two perceptual hashes (lower = more similar) -------
// Returns average per-frame Hamming distance, or Infinity if incomparable.
function phashDistance(a, b) {
  if (!a || !b || a.kind !== b.kind) return Infinity;
  const n = Math.min(a.frames.length, b.frames.length);
  if (!n) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += hamming(a.frames[i], b.frames[i]);
  return sum / n;
}

window.DC_hash = { sha256Hex, imagePHash, videoPHash, phashDistance };
})();
