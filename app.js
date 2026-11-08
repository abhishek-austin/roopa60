/* app.js — Roopa’s 60th birthday video collector.
 *
 * One static page, four moving parts:
 *   1. resolve who the guest is and which prompts they get (URL + guests.js + prompts.js)
 *   2. record up to 10 s per prompt with MediaRecorder (file-input fallback)
 *   3. review, then upload each clip sequentially as base64 JSON to Apps Script
 *   4. an unlinked admin link generator at /?admin=1
 *
 * Everything you are likely to change lives in CONFIG.
 */
"use strict";

const CONFIG = {
  // Google Apps Script Web App URL (ends in /exec). See google-apps-script/README.md.
  APPS_SCRIPT_URL: "PASTE_WEB_APP_URL_HERE",

  // Public site URL — used by the admin link generator.
  SITE_URL: "https://roopa60.theanbgroup.com/",

  HONOREE: "Roopa",
  MAX_SECONDS: 10,          // hard stop per answer
  PRE_ROLL_SECONDS: 3,      // "3… 2… 1…" before recording starts
  VIDEO_BITS_PER_SECOND: 1_200_000, // ≈1.5 MB per 10 s clip (≈2 MB as base64) — comfortably inside Apps Script limits
  AUDIO_BITS_PER_SECOND: 96_000,
  MAX_CLIP_BYTES: 25 * 1024 * 1024, // refuse absurdly large fallback files before uploading
  UPLOAD_RETRIES: 2,        // automatic retries per clip before showing the Retry button
  UPLOAD_TIMEOUT_MS: 120_000
};
window.ROOPA60_CONFIG = CONFIG; // handy for testing from the console

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function pad2(n) { return String(n).padStart(2, "0"); }
function fileTimestamp(d = new Date()) { return d.toISOString().replace(/\.\d{3}Z$/, "").replace(/:/g, "-"); }
function formatBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const EXT_BY_MIME = { "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/3gpp": "3gp" };
function baseMime(m) { return String(m || "").split(";")[0].trim().toLowerCase(); }
function extensionFor(mimeType, fileName) {
  const ext = EXT_BY_MIME[baseMime(mimeType)];
  if (ext) return ext;
  const m = /\.([a-z0-9]{2,5})$/i.exec(fileName || "");
  return m ? m[1].toLowerCase() : "webm";
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove(); return ok;
  }
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

/* Chrome records WebM without a duration header; nudging to the end fixes the scrubber. */
function fixDuration(video) {
  video.addEventListener("loadedmetadata", () => {
    if (video.duration === Infinity || Number.isNaN(video.duration)) {
      video.currentTime = 1e101;
      video.addEventListener("timeupdate", function once() {
        video.removeEventListener("timeupdate", once);
        video.currentTime = 0;
      });
    }
  }, { once: true });
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  guest: null,            // { slug, firstName, lastName, displayName, relationship }
  prompts: [],            // [{ id, text }] in the order the guest sees them
  clips: [],              // index -> { blob, mimeType, ext, url, size }
  current: 0,
  returnToReview: false,
  stream: null,
  recorder: null,
  chunks: [],
  recordTimer: null,
  tickTimer: null,
  preRollTimer: null,
  mimeType: "",
  useFallback: false,
  submissionId: null,
  uploaded: [],           // index -> true once Drive confirmed
  submitted: false,
  audioCtx: null
};

/* ------------------------------------------------------------------ */
/* Guest + prompt resolution                                           */
/* ------------------------------------------------------------------ */

function promptById(id) { return PROMPTS.find(p => p.id === id); }

function parsePromptIds(qs) {
  if (!qs) return null;
  const ids = [...new Set(qs.split(/[,\s]+/).map(n => parseInt(n, 10)).filter(n => promptById(n)))];
  return ids.length ? ids.slice(0, 5) : null;
}

function resolveGuest() {
  const slug = slugify(params.get("guest") || "");
  const configured = slug && GUESTS[slug];
  if (configured) {
    return { slug, firstName: configured.firstName || "", lastName: configured.lastName || "",
      displayName: configured.displayName || configured.firstName || "", relationship: configured.relationship || "",
      prompts: configured.prompts };
  }
  const fn = (params.get("fn") || "").trim();
  if (fn) {
    const ln = (params.get("ln") || "").trim();
    return { slug: slug || slugify(fn + " " + ln), firstName: fn, lastName: ln, displayName: fn,
      relationship: (params.get("rel") || "").trim(), prompts: null };
  }
  return null; // unknown — ask for a name
}

function resolvePrompts(guest) {
  const ids = parsePromptIds(params.get("q")) || (guest && guest.prompts) || DEFAULT_PROMPT_IDS;
  return ids.map(promptById).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Intro + name                                                        */
/* ------------------------------------------------------------------ */

function renderIntro() {
  const name = state.guest && state.guest.displayName;
  $("intro-greeting").textContent = (name ? `Hi ${name}! ` : "Hi! ") +
    `We’re putting together a surprise video for ${CONFIG.HONOREE}’s 60th birthday.`;
  const n = state.prompts.length;
  $("intro-sub").textContent = `We’d love for you to answer ${n} quick question${n === 1 ? "" : "s"}. Each response can be up to ${CONFIG.MAX_SECONDS} seconds.`;
  showScreen("screen-intro");
}

$("btn-start").addEventListener("click", () => {
  if (!state.guest) showScreen("screen-name");
  else showScreen("screen-permission");
});

$("name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const first = $("name-first").value.trim(), last = $("name-last").value.trim();
  if (!first) { $("name-error").hidden = false; $("name-first").focus(); return; }
  $("name-error").hidden = true;
  state.guest = { slug: slugify(first + " " + last), firstName: first, lastName: last, displayName: first, relationship: "" };
  state.prompts = resolvePrompts(state.guest);
  showScreen("screen-permission");
});

/* ------------------------------------------------------------------ */
/* Camera + permission                                                 */
/* ------------------------------------------------------------------ */

function recorderSupported() {
  return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function pickMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
  const candidates = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || ""; // "" = browser default
}

async function acquireStream() {
  const tiers = [
    { video: { facingMode: "user", width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 1280 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true } },
    { video: { facingMode: "user" }, audio: true },
    { video: true, audio: true }
  ];
  let lastErr;
  for (const constraints of tiers) {
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch (err) { lastErr = err; if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) break; }
  }
  throw lastErr;
}

function streamAlive() {
  return !!(state.stream && state.stream.getTracks().some(t => t.readyState === "live"));
}

function stopStream() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null;
  $("preview").srcObject = null;
}

async function ensureStream() {
  if (streamAlive()) return true;
  const stream = await acquireStream();
  state.stream = stream;
  stream.getTracks().forEach(t => { t.onended = () => { /* iOS drops tracks when backgrounded; re-acquired on next tap */ }; });
  const preview = $("preview");
  preview.srcObject = stream;
  try { await preview.play(); } catch (_) { /* autoplay muted is allowed; ignore */ }
  return true;
}

function permissionErrorMessage(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access was blocked. You can allow it in your browser settings, or use your phone’s camera app instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "We couldn’t find a camera on this device. You can use your phone’s camera app instead.";
  if (name === "NotReadableError")
    return "The camera is being used by another app. Close it and try again, or use your phone’s camera app.";
  return "We couldn’t start the camera here. Tip: open this link in Safari or Chrome, or use your phone’s camera app instead.";
}

$("btn-enable").addEventListener("click", async () => {
  const btn = $("btn-enable");
  $("permission-error").hidden = true;
  if (!recorderSupported()) { enterFallbackMode(); return; }
  btn.disabled = true; btn.textContent = "Starting camera…";
  try {
    await ensureStream();
    state.mimeType = pickMimeType();
    state.useFallback = false;
    state.current = 0;
    renderRecordScreen();
  } catch (err) {
    $("permission-error").textContent = permissionErrorMessage(err);
    $("permission-error").hidden = false;
    $("btn-use-fallback").hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Enable Camera";
  }
});

$("btn-use-fallback").addEventListener("click", enterFallbackMode);

function enterFallbackMode() {
  state.useFallback = true;
  stopStream();
  state.current = 0;
  renderRecordScreen();
}

/* ------------------------------------------------------------------ */
/* Record screen                                                       */
/* ------------------------------------------------------------------ */

function renderProgress() {
  const n = state.prompts.length, i = state.current;
  $("progress").hidden = false;
  $("progress-dots").innerHTML = state.prompts.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("");
  $("progress-step").textContent = `Question ${i + 1} of ${n}`;
}

function setStageMode(mode) { // 'idle' | 'countdown' | 'recording' | 'playback'
  const rec = mode === "recording";
  $("actions-idle").hidden = mode !== "idle" || state.useFallback;
  $("actions-recording").hidden = !rec;
  $("actions-playback").hidden = mode !== "playback";
  $("rec-indicator").hidden = !rec;
  $("ring").hidden = !rec;
  $("countdown").hidden = mode !== "countdown";
  $("playback").hidden = mode !== "playback";
  $("preview").hidden = mode === "playback" || state.useFallback;
  $("btn-toggle-preview").hidden = mode === "playback" || state.useFallback;
  $("fallback").hidden = !(state.useFallback && mode === "idle");
  $("stage").hidden = state.useFallback && mode !== "playback";
  document.body.classList.toggle("recording", rec);
  $("record-hint").textContent = mode === "playback" ? "Happy with it?" : `${CONFIG.MAX_SECONDS} seconds max`;
}

function renderRecordScreen() {
  const prompt = state.prompts[state.current];
  $("prompt-text").textContent = prompt.text;
  $("record-error").hidden = true;
  $("file-btn-label").textContent = "Record Answer";
  renderProgress();
  const pb = $("playback");
  if (pb.src) { URL.revokeObjectURL(pb.src); pb.removeAttribute("src"); pb.load(); }
  setStageMode("idle");
  showScreen("screen-record");
  if (!state.useFallback && streamAlive() && $("preview").srcObject !== state.stream) $("preview").srcObject = state.stream;
}

/* soft tick for the 3-2-1 countdown */
function beep(freq = 880, ms = 90, gain = 0.05) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!state.audioCtx) state.audioCtx = new Ctx();
    const ctx = state.audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = freq; osc.type = "sine";
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + ms / 1000);
  } catch (_) { /* audio is optional */ }
}

$("btn-record").addEventListener("click", async () => {
  $("record-error").hidden = true;
  try { await ensureStream(); }
  catch (err) {
    $("record-error").textContent = permissionErrorMessage(err);
    $("record-error").hidden = false;
    return;
  }
  startPreRoll();
});

function startPreRoll() {
  let n = CONFIG.PRE_ROLL_SECONDS;
  setStageMode("countdown");
  const el = $("countdown");
  const tick = () => {
    if (n <= 0) { beep(1320, 140, 0.06); startRecording(); return; }
    el.textContent = n; beep(880, 90);
    n--; state.preRollTimer = setTimeout(tick, 1000);
  };
  tick();
}

function startRecording() {
  if (!streamAlive()) { setStageMode("idle"); $("record-error").textContent = "The camera stopped. Please tap Record again."; $("record-error").hidden = false; return; }
  const options = { videoBitsPerSecond: CONFIG.VIDEO_BITS_PER_SECOND, audioBitsPerSecond: CONFIG.AUDIO_BITS_PER_SECOND };
  if (state.mimeType) options.mimeType = state.mimeType;
  let recorder;
  try { recorder = new MediaRecorder(state.stream, options); }
  catch (_) {
    try { recorder = new MediaRecorder(state.stream); } // let the browser choose
    catch (err) { enterFallbackMode(); return; }
  }
  state.recorder = recorder;
  state.chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
  recorder.onerror = () => { clearRecordTimers(); setStageMode("idle"); $("record-error").textContent = "Recording failed. Please try again."; $("record-error").hidden = false; };
  recorder.onstop = () => {
    clearRecordTimers();
    const type = baseMime(recorder.mimeType || state.mimeType) || "video/webm";
    const blob = new Blob(state.chunks, { type });
    if (!blob.size) { setStageMode("idle"); $("record-error").textContent = "Nothing was recorded. Please try again."; $("record-error").hidden = false; return; }
    showPlayback(blob, type, "");
  };

  recorder.start(250);
  setStageMode("recording");
  const started = Date.now(), total = CONFIG.MAX_SECONDS * 1000, ring = $("ring-progress");
  const update = () => {
    const left = Math.max(0, total - (Date.now() - started));
    $("rec-timeleft").textContent = Math.ceil(left / 1000);
    ring.style.strokeDashoffset = (100.53 * (1 - left / total)).toFixed(2);
  };
  update();
  state.tickTimer = setInterval(update, 100);
  state.recordTimer = setTimeout(stopRecording, total);
}

function clearRecordTimers() {
  clearTimeout(state.recordTimer); clearInterval(state.tickTimer); clearTimeout(state.preRollTimer);
  state.recordTimer = state.tickTimer = state.preRollTimer = null;
}

function stopRecording() {
  clearTimeout(state.recordTimer); state.recordTimer = null;
  const r = state.recorder;
  if (r && r.state !== "inactive") { try { r.requestData(); } catch (_) {} r.stop(); }
}

$("btn-stop").addEventListener("click", stopRecording);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.recorder && state.recorder.state === "recording") stopRecording();
});

function showPlayback(blob, mimeType, fileName) {
  const pb = $("playback");
  if (pb.src) URL.revokeObjectURL(pb.src);
  const url = URL.createObjectURL(blob);
  pb.src = url;
  fixDuration(pb);
  state.pending = { blob, mimeType, ext: extensionFor(mimeType, fileName), url, size: blob.size };
  setStageMode("playback");
  pb.play().catch(() => { /* user can press play */ });
}

$("btn-retake").addEventListener("click", () => {
  const pb = $("playback"); pb.pause();
  state.pending = null;
  renderRecordScreen();
});

$("btn-use").addEventListener("click", () => {
  const pb = $("playback"); pb.pause();
  if (!state.pending) return;
  const old = state.clips[state.current];
  if (old && old.url) URL.revokeObjectURL(old.url);
  state.clips[state.current] = state.pending;
  state.uploaded[state.current] = false;
  state.pending = null;
  pb.removeAttribute("src"); pb.load(); // keep the blob URL alive for the review screen

  if (state.returnToReview || state.current + 1 >= state.prompts.length) {
    state.returnToReview = false;
    renderReview();
  } else {
    state.current += 1;
    renderRecordScreen();
  }
});

/* preview on/off (stream keeps running so recording is unaffected) */
$("btn-toggle-preview").addEventListener("click", () => {
  const off = $("stage").classList.toggle("preview-off");
  $("stage-off").hidden = !off;
  $("btn-toggle-preview").setAttribute("aria-label", off ? "Show camera preview" : "Hide camera preview");
});

/* fallback: native camera app via <input type=file capture> */
$("file-input").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > CONFIG.MAX_CLIP_BYTES) {
    $("record-error").textContent = `That video is ${formatBytes(file.size)} — a bit too large. Please record a shorter clip of about ${CONFIG.MAX_SECONDS} seconds.`;
    $("record-error").hidden = false;
    return;
  }
  $("record-error").hidden = true;
  showPlayback(file, file.type || "video/mp4", file.name);
});

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

function renderReview() {
  $("progress").hidden = true;
  document.body.classList.remove("recording");
  stopStream(); // camera light off while they review; re-acquired silently on Retake

  const list = $("review-list");
  list.innerHTML = "";
  let total = 0;
  state.prompts.forEach((prompt, i) => {
    const clip = state.clips[i];
    if (!clip) return;
    total += clip.size;
    const node = $("tpl-review-item").content.firstElementChild.cloneNode(true);
    const video = node.querySelector("video");
    video.src = clip.url; fixDuration(video);
    node.querySelector(".review-q").textContent = `Question ${i + 1}`;
    node.querySelector(".review-prompt").textContent = prompt.text;
    node.querySelector("button").addEventListener("click", async () => {
      state.current = i; state.returnToReview = true;
      if (!state.useFallback) {
        try { await ensureStream(); }
        catch (err) { $("permission-error").textContent = permissionErrorMessage(err); $("permission-error").hidden = false; $("btn-use-fallback").hidden = false; showScreen("screen-permission"); return; }
      }
      renderRecordScreen();
    });
    list.appendChild(node);
  });
  $("size-estimate").textContent = `About ${formatBytes(Math.round(total * 1.37))} to upload`;
  showScreen("screen-review");
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the recording"));
    reader.readAsDataURL(blob);
  });
}

function isDemo() { return params.get("demo") === "1"; }
function endpointConfigured() { return /^https:\/\//.test(CONFIG.APPS_SCRIPT_URL); }

function buildPayload(i, base64) {
  const clip = state.clips[i], prompt = state.prompts[i], g = state.guest;
  const nameSlug = [slugify(g.firstName), slugify(g.lastName)].filter(Boolean).join("-") || "guest";
  return {
    submissionId: state.submissionId,
    guest: { slug: g.slug, firstName: g.firstName, lastName: g.lastName, displayName: g.displayName, relationship: g.relationship },
    prompt: { id: prompt.id, text: prompt.text },
    position: i + 1,
    total: state.prompts.length,
    filename: `${pad2(prompt.id)}-${nameSlug}-${fileTimestamp()}.${clip.ext}`,
    mimeType: baseMime(clip.mimeType) || "video/webm",
    sizeBytes: clip.size,
    durationTarget: CONFIG.MAX_SECONDS,
    userAgent: navigator.userAgent.slice(0, 200),
    data: base64
  };
}

function postJson(payload, onProgress) {
  if (isDemo()) { // simulate a slow upload locally
    return new Promise(res => { let p = 0; const t = setInterval(() => { p += 0.2; onProgress(Math.min(1, p)); if (p >= 1) { clearInterval(t); res({ ok: true, demo: true }); } }, 150); });
  }
  if (!endpointConfigured()) return Promise.reject(new Error("The upload service isn’t set up yet (APPS_SCRIPT_URL). Please let the organiser know."));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CONFIG.APPS_SCRIPT_URL);
    // text/plain avoids a CORS pre-flight, which Apps Script cannot answer. Body is still JSON.
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
    xhr.timeout = CONFIG.UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Server responded with ${xhr.status}`));
      let res; try { res = JSON.parse(xhr.responseText); } catch (_) { return reject(new Error("Unexpected response from the upload service")); }
      res && res.ok ? resolve(res) : reject(new Error((res && res.error) || "The upload was rejected"));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("The upload timed out"));
    xhr.send(JSON.stringify(payload));
  });
}

async function uploadAll() {
  const n = state.prompts.length;
  const bar = $("upload-bar"), status = $("upload-status");
  $("upload-error").hidden = true;
  $("upload-note").hidden = false;
  if (!state.submissionId) state.submissionId = `roopa60-${Date.now()}-${state.guest.slug || "guest"}`;

  for (let i = 0; i < n; i++) {
    if (state.uploaded[i]) continue;
    status.textContent = `Uploading ${i + 1} of ${n}…`;
    const setProgress = (frac) => { bar.style.width = `${((i + frac) / n) * 100}%`; };
    setProgress(0);
    const base64 = await blobToBase64(state.clips[i].blob);
    const payload = buildPayload(i, base64);

    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.UPLOAD_RETRIES; attempt++) {
      try {
        if (attempt) { status.textContent = `Uploading ${i + 1} of ${n}… (retrying)`; await sleep(1500 * attempt); }
        await postJson(payload, setProgress);
        state.uploaded[i] = true; lastErr = null; break;
      } catch (err) { lastErr = err; }
    }
    if (lastErr) {
      status.textContent = `Upload ${i + 1} of ${n} didn’t go through`;
      $("upload-note").hidden = true;
      $("upload-error-text").textContent = `${lastErr.message}. Your recordings are safe on this page — check your connection and tap Retry.`;
      $("upload-error").hidden = false;
      return;
    }
  }
  bar.style.width = "100%";
  state.submitted = true;
  await sleep(400);
  showScreen("screen-done");
}

$("btn-submit").addEventListener("click", () => {
  if (state.prompts.some((_, i) => !state.clips[i])) { toast("One answer is missing"); return; }
  $("upload-bar").style.width = "0%";
  showScreen("screen-upload");
  uploadAll();
});
$("btn-retry-upload").addEventListener("click", uploadAll);

/* don't lose recordings to an accidental back-swipe */
window.addEventListener("beforeunload", (e) => {
  if (!state.submitted && state.clips.some(Boolean)) { e.preventDefault(); e.returnValue = ""; }
});

/* ------------------------------------------------------------------ */
/* Admin link generator (/?admin=1)                                    */
/* ------------------------------------------------------------------ */

function initAdmin() {
  const STORAGE_KEY = "roopa60-admin-links";
  const selected = []; // prompt ids in selection order
  const preset = $("adm-preset");
  Object.entries(GUESTS).forEach(([slug, g]) => {
    const o = document.createElement("option"); o.value = slug; o.textContent = `${g.firstName} ${g.lastName || ""} (${slug})`.trim(); preset.appendChild(o);
  });
  preset.addEventListener("change", () => {
    const g = GUESTS[preset.value]; if (!g) return;
    $("adm-first").value = g.firstName || ""; $("adm-last").value = g.lastName || ""; $("adm-rel").value = g.relationship || "";
    selected.length = 0; (g.prompts || DEFAULT_PROMPT_IDS).forEach(id => promptById(id) && selected.push(id));
    syncPromptBoxes();
  });

  const fs = $("adm-prompts");
  PROMPTS.forEach(p => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${p.id}"><span class="order"></span><span>${escapeHtml(p.text)}</span>`;
    fs.appendChild(label);
  });
  function syncPromptBoxes() {
    fs.querySelectorAll("input").forEach(box => {
      const id = Number(box.value), idx = selected.indexOf(id);
      box.checked = idx >= 0;
      box.disabled = idx < 0 && selected.length >= 3;
      box.nextElementSibling.textContent = idx >= 0 ? idx + 1 : "";
    });
    $("adm-count").textContent = `(${selected.length} of 3)`;
  }
  fs.addEventListener("change", (e) => {
    const id = Number(e.target.value), idx = selected.indexOf(id);
    if (e.target.checked && idx < 0 && selected.length < 3) selected.push(id);
    else if (!e.target.checked && idx >= 0) selected.splice(idx, 1);
    syncPromptBoxes();
  });
  syncPromptBoxes();

  let current = null;
  function buildLink(first, last, rel, ids, includeName) {
    const slug = slugify(`${first} ${last}`);
    const u = new URL(CONFIG.SITE_URL);
    u.searchParams.set("guest", slug);
    u.searchParams.set("q", ids.join(","));
    if (includeName && !GUESTS[slug]) {
      u.searchParams.set("fn", first);
      if (last) u.searchParams.set("ln", last);
      if (rel) u.searchParams.set("rel", rel);
    }
    return { slug, link: u.toString().replace(/%2C/g, ",") };
  }
  function buildMessage(first, link) {
    return `Hi ${first}! We’re putting together a surprise for ${CONFIG.HONOREE}’s 60th birthday. Could you record three very short video answers for us? It should only take a couple of minutes:\n${link}\nPlease keep it a surprise 😊`;
  }

  $("adm-generate").addEventListener("click", () => {
    const first = $("adm-first").value.trim(), last = $("adm-last").value.trim(), rel = $("adm-rel").value.trim();
    const err = $("adm-error");
    if (!first) { err.textContent = "First name is required."; err.hidden = false; return; }
    if (selected.length !== 3) { err.textContent = "Please choose exactly 3 questions."; err.hidden = false; return; }
    err.hidden = true;
    const ids = selected.slice();
    const { slug, link } = buildLink(first, last, rel, ids, $("adm-include-name").checked);
    const message = buildMessage(first, link);
    current = { first, last, rel, slug, ids, link, message };
    $("adm-link").value = link; $("adm-msg").value = message; $("adm-open").href = link;
    try { QR.drawCanvas($("adm-qr"), link, 8); $("adm-qr-download").href = $("adm-qr").toDataURL("image/png"); $("adm-qr-download").download = `roopa60-${slug}.png`; }
    catch (e) { $("adm-qr").getContext("2d").clearRect(0, 0, 9999, 9999); }
    $("adm-snippet").textContent =
`  "${slug}": {
    firstName: ${JSON.stringify(first)},
    lastName: ${JSON.stringify(last)},
    displayName: ${JSON.stringify(first)},
    relationship: ${JSON.stringify(rel)},
    prompts: [${ids.join(", ")}]
  },`;
    $("adm-output").hidden = false;
    $("adm-output").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("adm-copy-link").addEventListener("click", async () => toast(await copyText($("adm-link").value) ? "Link copied" : "Copy failed — select the text"));
  $("adm-copy-msg").addEventListener("click", async () => toast(await copyText($("adm-msg").value) ? "Message copied" : "Copy failed — select the text"));

  /* saved list + CSV */
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch (_) { saved = []; }
  function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (_) {} }
  function renderList() {
    const wrap = $("adm-list-wrap"); wrap.hidden = saved.length === 0;
    $("adm-list-count").textContent = saved.length ? `(${saved.length})` : "";
    const tbody = $("adm-list").querySelector("tbody"); tbody.innerHTML = "";
    saved.forEach((row, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(`${row.first} ${row.last}`.trim())}</td><td>${escapeHtml(row.rel)}</td><td>${row.ids.join(",")}</td>
        <td><button class="mini" data-act="link" data-i="${i}">Link</button><button class="mini" data-act="msg" data-i="${i}">Msg</button><button class="mini" data-act="del" data-i="${i}">✕</button></td>`;
      tbody.appendChild(tr);
    });
  }
  $("adm-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const row = saved[Number(b.dataset.i)]; if (!row) return;
    if (b.dataset.act === "link") toast(await copyText(row.link) ? "Link copied" : "Copy failed");
    if (b.dataset.act === "msg") toast(await copyText(row.message) ? "Message copied" : "Copy failed");
    if (b.dataset.act === "del") { saved.splice(Number(b.dataset.i), 1); persist(); renderList(); }
  });
  $("adm-add").addEventListener("click", () => {
    if (!current) return;
    const dup = saved.findIndex(r => r.slug === current.slug);
    if (dup >= 0) saved[dup] = current; else saved.push(current);
    persist(); renderList(); toast(dup >= 0 ? "Updated in list" : "Added to list");
  });
  $("adm-clear").addEventListener("click", () => { if (confirm("Clear all saved links?")) { saved = []; persist(); renderList(); } });
  $("adm-export").addEventListener("click", () => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["First Name", "Last Name", "Relationship", "Slug", "Prompts", "Link", "WhatsApp Message"].map(q).join(",")];
    saved.forEach(r => lines.push([r.first, r.last, r.rel, r.slug, r.ids.join(" "), r.link, r.message].map(q).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "roopa60-guest-links.csv";
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  renderList();
  showScreen("screen-admin");
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(function boot() {
  if (params.get("admin") === "1") { initAdmin(); return; }
  state.guest = resolveGuest();
  state.prompts = resolvePrompts(state.guest);
  renderIntro();
})();
