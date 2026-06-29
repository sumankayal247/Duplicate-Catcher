// Duplicates Catcher — main app logic.
// Flow: home -> upload -> processing -> review -> done.
// Everything runs locally in the browser; no file ever leaves the device.

const { sha256Hex, imagePHash, videoPHash, phashDistance } = window.DC_hash;
const { makeZip } = window.DC_zip;

// Perceptual match thresholds (avg Hamming distance over 64-bit hashes).
// Lower = stricter. Exact byte matches are always grouped regardless.
const THRESHOLD = { image: 10, video: 14 };

const state = {
  mode: null, // 'image' | 'video'
  items: [], // { id, file, sha, phash }
  pairs: [], // { original, dup, exact, distance, similarity, refuted }
  reviewUrls: [], // object URLs to revoke
};

const $ = (sel) => document.querySelector(sel);
const screens = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  ['home', 'upload', 'processing', 'review', 'done'].forEach((s) => {
    screens[s] = $(`#screen-${s}`);
  });

  $('#tile-video').addEventListener('click', () => startMode('video'));
  $('#tile-image').addEventListener('click', () => startMode('image'));
  document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', goHome));

  const input = $('#file-input');
  const drop = $('#dropzone');
  $('#pick-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => addFiles(input.files));

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('dragging');
    })
  );
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  $('#find-btn').addEventListener('click', process);
  $('#clear-btn').addEventListener('click', clearFiles);
  $('#confirm-btn').addEventListener('click', buildAndDownload);
}

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
  window.scrollTo(0, 0);
}

function goHome() {
  releaseUrls();
  state.mode = null;
  state.items = [];
  state.pairs = [];
  $('#file-input').value = '';
  showScreen('home');
}

let nextId = 1;

function startMode(mode) {
  state.mode = mode;
  state.items = [];
  $('#file-input').value = '';
  $('#file-input').setAttribute('accept', mode === 'video' ? 'video/*' : 'image/*');
  $('#upload-title').textContent = mode === 'video' ? 'Upload your videos' : 'Upload your photos';
  $('#upload-sub').textContent =
    mode === 'video'
      ? 'Bulk-add videos. We match by content, even across re-encodes and renames.'
      : 'Bulk-add photos. We match by content, even resized, recompressed or renamed.';
  renderFileList();
  showScreen('upload');
}

function addFiles(fileList) {
  const wantType = state.mode === 'video' ? 'video/' : 'image/';
  let skipped = 0;
  for (const file of fileList) {
    const okByType = file.type ? file.type.startsWith(wantType) : true;
    if (!okByType) {
      skipped++;
      continue;
    }
    // de-dupe the picker itself by name+size+lastModified
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (state.items.some((it) => it.key === key)) continue;
    state.items.push({ id: nextId++, key, file, sha: null, phash: null });
  }
  $('#file-input').value = '';
  renderFileList();
  if (skipped) flash($('#upload-note'), `${skipped} file(s) skipped — wrong type for ${state.mode}s.`);
}

function clearFiles() {
  state.items = [];
  $('#file-input').value = '';
  renderFileList();
}

function renderFileList() {
  const list = $('#file-list');
  const count = state.items.length;
  $('#file-count').textContent = count;
  $('#find-btn').disabled = count < 2;
  $('#clear-btn').disabled = count === 0;
  $('#find-hint').textContent =
    count < 2 ? 'Add at least 2 files to scan for duplicates.' : `Ready to scan ${count} ${state.mode}s.`;

  list.innerHTML = '';
  for (const it of state.items) {
    const li = document.createElement('li');
    li.className = 'file-chip';
    const name = document.createElement('span');
    name.className = 'file-chip-name';
    name.textContent = it.file.name; // textContent — never inject HTML from names
    name.title = it.file.name;
    const size = document.createElement('span');
    size.className = 'file-chip-size';
    size.textContent = humanSize(it.file.size);
    const x = document.createElement('button');
    x.className = 'file-chip-x';
    x.setAttribute('aria-label', 'Remove');
    x.textContent = '✕';
    x.addEventListener('click', () => {
      state.items = state.items.filter((f) => f.id !== it.id);
      renderFileList();
    });
    li.append(name, size, x);
    list.appendChild(li);
  }
}

// ---- Processing ----------------------------------------------------------
async function process() {
  showScreen('processing');
  const items = state.items;
  const bar = $('#proc-bar');
  const label = $('#proc-label');

  // --- Streamline: bucket by exact byte size first. ---------------------
  // Identical content ALWAYS has identical size, so a file whose size no one
  // else shares can't be a byte-exact duplicate — skip reading & SHA-256 for
  // it. (Perceptual matching below still spans all sizes, so resized /
  // re-encoded copies under different names are NOT missed.)
  const sizeBuckets = new Map();
  for (const it of items) {
    if (!sizeBuckets.has(it.file.size)) sizeBuckets.set(it.file.size, []);
    sizeBuckets.get(it.file.size).push(it);
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    label.textContent = `Analyzing ${i + 1} / ${items.length}: ${it.file.name}`;
    bar.style.width = `${Math.round((i / items.length) * 100)}%`;
    await yieldUI();

    const sizeShared = sizeBuckets.get(it.file.size).length > 1;
    if (sizeShared) {
      try {
        const buf = await it.file.arrayBuffer();
        it.sha = await sha256Hex(buf); // exact content fingerprint
        // buf released after this scope — re-read lazily at zip time to save memory
      } catch (e) {
        it.sha = `unhashable-${it.id}`;
      }
    } else {
      // Unique size → impossible byte-exact duplicate; give it a sha that
      // can never collide so the exact pass skips it for free.
      it.sha = `unique-size-${it.id}`;
    }

    try {
      it.phash = state.mode === 'image' ? await imagePHash(it.file) : await videoPHash(it.file);
    } catch (e) {
      it.phash = null; // fall back to exact-only matching for this file
    }
  }

  bar.style.width = '100%';
  label.textContent = 'Grouping duplicates…';
  await yieldUI();

  buildPairs(cluster());
  renderReview();
  showScreen('review');
}

// Union-find clustering by exact OR perceptual similarity.
function cluster() {
  const items = state.items;
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 1) exact byte-identical content (handles "same content, different name")
  const shaMap = new Map();
  items.forEach((it, i) => {
    if (shaMap.has(it.sha)) union(shaMap.get(it.sha), i);
    else shaMap.set(it.sha, i);
  });

  // 2) perceptually near-identical content
  const limit = THRESHOLD[state.mode];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (find(i) === find(j)) continue;
      const d = phashDistance(items[i].phash, items[j].phash);
      if (d <= limit) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

function buildPairs(groups) {
  const items = state.items;
  const pairs = [];
  for (const g of groups) {
    g.sort((a, b) => a - b); // upload order; first = the original we keep
    const orig = g[0];
    for (let k = 1; k < g.length; k++) {
      const dup = g[k];
      const exact = items[dup].sha === items[orig].sha;
      const dist = exact ? 0 : phashDistance(items[orig].phash, items[dup].phash);
      const similarity = exact ? 100 : Math.max(0, Math.round((1 - dist / 64) * 100));
      pairs.push({ original: orig, dup, exact, distance: dist, similarity, refuted: false });
    }
  }
  state.pairs = pairs;
}

// ---- Review --------------------------------------------------------------
function mediaEl(file) {
  const url = URL.createObjectURL(file);
  state.reviewUrls.push(url);
  let el;
  if (state.mode === 'video') {
    el = document.createElement('video');
    el.src = url;
    el.controls = true;
    el.muted = true;
    el.preload = 'metadata';
  } else {
    el = document.createElement('img');
    el.src = url;
    el.loading = 'lazy';
    el.alt = file.name;
  }
  el.className = 'media';
  return el;
}

function side(file, badgeText, badgeClass) {
  const wrap = document.createElement('div');
  wrap.className = 'side';
  const badge = document.createElement('span');
  badge.className = `badge ${badgeClass}`;
  badge.textContent = badgeText;
  wrap.appendChild(badge);
  wrap.appendChild(mediaEl(file));
  const name = document.createElement('div');
  name.className = 'side-name';
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement('div');
  meta.className = 'side-meta';
  meta.textContent = humanSize(file.size);
  wrap.append(name, meta);
  return wrap;
}

function renderReview() {
  releaseUrls();
  const items = state.items;
  const grid = $('#pairs');
  grid.innerHTML = '';

  if (!state.pairs.length) {
    $('#review-title').textContent = 'No duplicates found 🎉';
    $('#review-sub').textContent = 'Every file looks unique. You can still bundle them all below.';
    grid.innerHTML = '<div class="empty">Nothing to review — no duplicate content detected.</div>';
    updateConfirmBar();
    return;
  }

  $('#review-title').textContent = 'Review the duplicates';
  $('#review-sub').textContent =
    'Each suspected duplicate is shown beside the original it matches. Refute any pair you disagree with.';

  state.pairs.forEach((pair, idx) => {
    const card = document.createElement('div');
    card.className = 'pair-card';
    card.dataset.idx = idx;

    const head = document.createElement('div');
    head.className = 'pair-head';
    const tag = document.createElement('span');
    tag.className = `match-tag ${pair.exact ? 'exact' : 'near'}`;
    tag.textContent = pair.exact ? 'Exact copy (identical content)' : `~${pair.similarity}% similar content`;
    head.appendChild(tag);

    const refuteBtn = document.createElement('button');
    refuteBtn.className = 'refute-btn';
    refuteBtn.addEventListener('click', () => {
      pair.refuted = !pair.refuted;
      syncCard(card, pair, refuteBtn);
      updateConfirmBar();
    });
    head.appendChild(refuteBtn);

    const body = document.createElement('div');
    body.className = 'pair-body';
    body.append(
      side(items[pair.original].file, '✔ Original (kept)', 'orig'),
      side(items[pair.dup].file, '✖ Duplicate (removed)', 'dup')
    );

    card.append(head, body);
    grid.appendChild(card);
    syncCard(card, pair, refuteBtn);
  });

  updateConfirmBar();
}

function syncCard(card, pair, btn) {
  card.classList.toggle('refuted', pair.refuted);
  btn.textContent = pair.refuted ? '↺ Restore as duplicate' : '✋ Refute — not a duplicate';
  btn.classList.toggle('active', pair.refuted);
  const dupBadge = card.querySelector('.side .badge.dup');
  if (dupBadge) {
    dupBadge.textContent = pair.refuted ? '✔ Kept (you refuted)' : '✖ Duplicate (removed)';
    dupBadge.classList.toggle('orig', pair.refuted);
    dupBadge.classList.toggle('dup', !pair.refuted);
  }
}

function confirmedRemovedIds() {
  return new Set(state.pairs.filter((p) => !p.refuted).map((p) => state.items[p.dup].id));
}

function updateConfirmBar() {
  const removed = confirmedRemovedIds();
  const kept = state.items.length - removed.size;
  $('#confirm-stats').textContent =
    `${state.items.length} uploaded · ${removed.size} duplicate(s) to remove · ${kept} original(s) to keep`;
}

// ---- Build & download ----------------------------------------------------
async function buildAndDownload() {
  const btn = $('#confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Bundling originals…';

  const removed = confirmedRemovedIds();
  const keep = state.items.filter((it) => !removed.has(it.id));

  const used = new Set();
  const entries = [];
  for (const it of keep) {
    let buf;
    try {
      buf = new Uint8Array(await it.file.arrayBuffer());
    } catch (e) {
      continue;
    }
    entries.push({ name: uniqueName(it.file.name, used), data: buf });
  }

  const blob = makeZip(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duplicates-catcher-originals-${state.mode}s.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  $('#done-stats').textContent =
    `${entries.length} original ${state.mode}(s) bundled · ${removed.size} duplicate(s) dropped`;
  $('#done-size').textContent = `ZIP size: ${humanSize(blob.size)}`;
  btn.disabled = false;
  btn.textContent = "Yeah, That's all of them";
  releaseUrls();
  showScreen('done');
}

// ---- Helpers -------------------------------------------------------------
function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate;
  do {
    candidate = `${base} (${n})${ext}`;
    n++;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

function releaseUrls() {
  state.reviewUrls.forEach((u) => URL.revokeObjectURL(u));
  state.reviewUrls = [];
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function yieldUI() {
  return new Promise((r) => setTimeout(r, 0));
}

let flashTimer;
function flash(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
