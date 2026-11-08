/**
 * Roopa’s 60th — video upload endpoint (Google Apps Script Web App).
 *
 * Receives one video per POST as JSON { ...metadata, data: "<base64>" },
 * saves it into  <DRIVE_FOLDER>/Prompt NN/  and appends a row to the Sheet.
 *
 * Deploy:  Deploy → New deployment → Web app
 *          Execute as: Me   ·   Who has access: Anyone
 * Then paste the Web app URL into CONFIG.APPS_SCRIPT_URL in app.js.
 *
 * Run setup() once from the editor to grant permissions, create the
 * header row and the prompt sub-folders.
 */

const DRIVE_FOLDER_ID = "PASTE_FOLDER_ID_HERE";
const SHEET_ID = "PASTE_SHEET_ID_HERE";
const SHEET_NAME = "Submissions";

// DriveApp.createFile() refuses blobs over 50 MB. A 10 s clip from the app is ~1–3 MB.
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const PROMPT_COUNT = 8; // used by setup() to pre-create folders

const HEADERS = [
  "Submission ID", "Timestamp", "First Name", "Last Name", "Display Name", "Relationship",
  "Prompt Number", "Prompt Text", "Filename", "Drive File ID", "Drive URL", "MIME Type",
  "File Size", "Duration Target", "Guest Slug", "Status"
];

const EXT_BY_MIME = {
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
  "video/x-m4v": ".m4v"
};

/** Health check: open the Web app URL in a browser. */
function doGet() {
  return jsonResponse_({ ok: true, service: "roopa60-upload", time: new Date().toISOString() });
}

/** Upload endpoint. */
function doPost(e) {
  let body = null;
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("Empty request body");
    body = JSON.parse(e.postData.contents);
    return jsonResponse_(handleUpload_(body));
  } catch (err) {
    const message = String((err && err.message) || err);
    try { logRow_(body || {}, null, "ERROR: " + message); } catch (_) { /* logging must never mask the response */ }
    return jsonResponse_({ ok: false, error: message });
  }
}

function handleUpload_(body) {
  const guest = body.guest || {};
  const prompt = body.prompt || {};
  const promptId = parseInt(prompt.id, 10);
  if (!promptId || promptId < 1 || promptId > 99) throw new Error("Invalid prompt id");
  if (typeof body.data !== "string" || !body.data) throw new Error("Missing video data");

  const base64 = body.data.replace(/^data:[^;]+;base64,/, "");
  const bytes = Utilities.base64Decode(base64);
  if (!bytes.length) throw new Error("Empty video");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Video too large (" + Math.round(bytes.length / 1048576) + " MB)");

  const mimeType = normalizeMime_(body.mimeType);
  const filename = buildFilename_(promptId, guest.firstName, guest.lastName, mimeType, body.filename);
  const blob = Utilities.newBlob(bytes, mimeType, filename);

  const file = getPromptFolder_(promptId).createFile(blob);
  // Files inherit the parent folder's sharing (private to you by default). No public links are created.

  logRow_(body, file, "OK");

  return {
    ok: true,
    submissionId: body.submissionId || "",
    promptId: promptId,
    fileId: file.getId(),
    fileName: file.getName(),
    size: bytes.length
  };
}

/* ---------------- Drive ---------------- */

function getPromptFolder_(promptId) {
  const name = "Prompt " + pad2_(promptId);
  const parent = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  // Lock so two simultaneous uploads don't both create "Prompt 01".
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const existing = parent.getFoldersByName(name);
    return existing.hasNext() ? existing.next() : parent.createFolder(name);
  } finally {
    lock.releaseLock();
  }
}

function buildFilename_(promptId, firstName, lastName, mimeType, clientFilename) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH-mm-ss");
  const name = [slug_(firstName), slug_(lastName)].filter(Boolean).join("-") || "guest";
  return pad2_(promptId) + "-" + name + "-" + stamp + extensionFor_(mimeType, clientFilename);
}

function extensionFor_(mimeType, clientFilename) {
  if (EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(clientFilename || ""));
  return m ? "." + m[1].toLowerCase() : ".webm";
}

function normalizeMime_(mime) {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  return /^video\/[a-z0-9.+-]+$/.test(base) ? base : "video/webm";
}

/* ---------------- Sheet ---------------- */

function getSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logRow_(body, file, status) {
  const guest = body.guest || {};
  const prompt = body.prompt || {};
  getSheet_().appendRow([
    body.submissionId || "",
    new Date(),
    guest.firstName || "",
    guest.lastName || "",
    guest.displayName || guest.firstName || "",
    guest.relationship || "",
    prompt.id || "",
    prompt.text || "",
    file ? file.getName() : (body.filename || ""),
    file ? file.getId() : "",
    file ? file.getUrl() : "",
    normalizeMime_(body.mimeType),
    file ? file.getSize() : "",
    body.durationTarget || "",
    guest.slug || "",
    status
  ]);
}

/* ---------------- helpers ---------------- */

function slug_(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function pad2_(n) { return (n < 10 ? "0" : "") + n; }

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- one-time setup / self-test (run from the editor) ---------------- */

/**
 * Run this once after pasting your IDs. It triggers the permission prompt,
 * verifies access to the folder and sheet, writes the header row and
 * pre-creates the "Prompt 01".."Prompt 08" folders.
 */
function setup() {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  Logger.log("Drive folder OK: " + folder.getName());
  for (let i = 1; i <= PROMPT_COUNT; i++) getPromptFolder_(i);
  Logger.log("Prompt folders OK");
  const sheet = getSheet_();
  Logger.log("Sheet OK: " + sheet.getParent().getName() + " / " + sheet.getName());
}

/** Writes a tiny test file through the real upload path, then logs the result. */
function selfTest() {
  const result = handleUpload_({
    submissionId: "roopa60-selftest-" + Date.now(),
    guest: { slug: "self-test", firstName: "Self", lastName: "Test", displayName: "Self", relationship: "Test" },
    prompt: { id: 1, text: "Self test — safe to delete" },
    filename: "01-self-test.webm",
    mimeType: "video/webm",
    durationTarget: 10,
    data: Utilities.base64Encode("not really a video")
  });
  Logger.log(JSON.stringify(result));
}
