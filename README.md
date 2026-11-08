# Roopa’s 60th — birthday video collector

A one-page, mobile-first static site that asks each guest three short questions and
records a ≤10‑second selfie video answer for each. Videos are uploaded to a private
Google Drive folder via a Google Apps Script web app and logged in a Google Sheet.

```
Guest’s phone (WhatsApp link)
   │  https://roopa60.theanbgroup.com/?guest=ravi-shah&q=1,4,5
   ▼
GitHub Pages  (index.html · styles.css · app.js · prompts.js · guests.js · qr.js)
   │  HTTPS POST, JSON body with base64 video — one clip at a time
   ▼
Google Apps Script web app  (google-apps-script/Code.gs → doPost)
   ├─▶ Google Drive   <folder>/Prompt 01/01-ravi-shah-2026-12-01T18-42-31.webm
   └─▶ Google Sheet   one row per video, shared Submission ID per guest
```

No accounts, no sign-in, no app install, no build step, no dependencies.

---

## Repository layout

| File | Purpose |
|---|---|
| `index.html` | the single page (all screens, including the admin generator) |
| `styles.css` | winter-wonderland theme: ivory, champagne gold, sage, blush |
| `app.js` | guest flow, recording, upload, admin generator. **`CONFIG` at the top is the only thing you must edit.** |
| `prompts.js` | the prompt bank + default prompt IDs |
| `guests.js` | optional per-guest config (name, relationship, prompt IDs) |
| `qr.js` | tiny dependency-free QR encoder used by the admin page |
| `CNAME` | `roopa60.theanbgroup.com` for GitHub Pages |
| `.nojekyll` | tells Pages to serve files as-is |
| `google-apps-script/Code.gs` | the backend (`doPost`) |
| `google-apps-script/README.md` | backend setup in detail |

---

## 1. Fill in these values

| Where | Constant | Value |
|---|---|---|
| `app.js` → `CONFIG` | `APPS_SCRIPT_URL` | the Apps Script **Web app URL** (ends in `/exec`) |
| `app.js` → `CONFIG` | `SITE_URL` | already `https://roopa60.theanbgroup.com/` |
| `google-apps-script/Code.gs` | `DRIVE_FOLDER_ID` | ID of the Drive folder that will hold the videos |
| `google-apps-script/Code.gs` | `SHEET_ID` | ID of the Google Sheet that logs submissions |

Nothing else is secret. The Web app URL is the only backend value that ships to browsers.

---

## 2. Google Drive

1. In Drive, create a folder, e.g. **Roopa 60 Videos**. Keep it private (default).
2. Open it. The URL is `https://drive.google.com/drive/folders/`**`<FOLDER_ID>`** — copy that ID.
3. Sub-folders `Prompt 01` … `Prompt 08` are created automatically (one per prompt **ID**,
   so every answer to the same question lands together, whichever guest answered it).

## 3. Google Sheet

1. Create a Sheet, e.g. **Roopa 60 Submissions**.
2. The URL is `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit` — copy that ID.
3. The header row is written automatically on first use (tab **Submissions**):

   `Submission ID · Timestamp · First Name · Last Name · Display Name · Relationship · Prompt Number · Prompt Text · Filename · Drive File ID · Drive URL · MIME Type · File Size · Duration Target · Guest Slug · Status`

   If you prefer to create it by hand, paste exactly those 16 headings in row 1.

## 4. Apps Script

1. <https://script.google.com> → **New project** → paste `google-apps-script/Code.gs` over the default code.
2. Set `DRIVE_FOLDER_ID` and `SHEET_ID`.
3. Select the `setup` function in the toolbar → **Run** → approve permissions. Check the log says OK.
4. **Deploy → New deployment → ⚙ Web app**
   * Execute as: **Me**
   * Who has access: **Anyone**  ← required so guests can post without signing in
   * **Deploy** → copy the **Web app URL**.
5. Put that URL into `CONFIG.APPS_SCRIPT_URL` in `app.js`. Commit and push.
6. Open the URL in a browser: `{"ok":true,"service":"roopa60-upload"...}` means it’s live.

> Changing the script later? **Deploy → Manage deployments → ✏ → New version → Deploy.**
> Saving alone does not update the live URL.

More detail, a curl test and the limits analysis are in `google-apps-script/README.md`.

## 5. GitHub Pages + custom domain

1. Repo **Settings → Pages**.
2. **Source:** *Deploy from a branch*. **Branch:** `main` (or whichever branch holds these files), folder `/ (root)`. Save.
3. **Custom domain:** enter `roopa60.theanbgroup.com` → Save. (The `CNAME` file in the repo keeps this setting across deploys.)
4. Wait for the DNS check to pass, then tick **Enforce HTTPS**. The certificate is issued automatically; it can take a few minutes to an hour after DNS resolves.

### DNS (at the registrar / DNS host for `theanbgroup.com`)

Add one record:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| `CNAME` | `roopa60` | `<your-github-username>.github.io.` | 3600 |

That's it — a subdomain needs only a CNAME to `<username>.github.io` (use the
*owner* of the repository; for an organisation it's `<org>.github.io`). Do **not**
use the A/AAAA records — those are for apex domains only. Verify with:

```bash
dig +short roopa60.theanbgroup.com CNAME
```

Pages serves over HTTPS; the camera API (`getUserMedia`) only works on HTTPS, so
don't test via plain `http://` except on `localhost`.

---

## How it works

### Links
* `/?guest=ravi-shah` — guest from `guests.js` (name + their configured prompts)
* `/?guest=ravi-shah&q=1,4,5` — same guest, prompt IDs overridden by the URL
* `/?guest=anita-rao&q=2,6,8&fn=Anita&ln=Rao&rel=Colleague` — guest **not** in `guests.js`;
  name comes from the URL so they are never asked to type it (the admin page generates these)
* `/?guest=somebody-unknown` or `/` — asks for first/last name, uses the default prompts
* `/?admin=1` — link generator (not linked from anywhere, not secret either)
* `/?guest=ravi-shah&demo=1` — full flow with a *simulated* upload (nothing is sent)

### Recording
* `getUserMedia` with `facingMode: "user"`, ideal 1280×720, max 720p, 30 fps.
* `MediaRecorder` with `videoBitsPerSecond: 1.2 Mbps`, `audioBitsPerSecond: 96 kbps`.
  MIME type: first supported of `video/webm;codecs=vp8,opus` → `video/webm` → `video/mp4` → browser default.
  Safari (iOS 14.5+/macOS) records `video/mp4` (H.264/AAC), which is saved as `.mp4`.
* 3‑2‑1 pre-roll with a soft tick, 10 s ring + countdown, manual **Stop**, hard stop at 10 s.
* **Fallback** when `MediaRecorder` is missing or the camera can't be opened (old iOS,
  some in-app browsers): `<input type="file" accept="video/*" capture="user">` opens the
  phone's own camera app; the resulting `.mov`/`.mp4` is uploaded unchanged.

### Upload
* Clips are kept in memory and sent **one at a time** after *Submit My Videos*.
* Each clip → base64 → JSON → `POST` with `Content-Type: text/plain` (avoids a CORS
  pre-flight, which Apps Script cannot answer). Progress bar via XHR upload events.
* 2 automatic retries per clip with back-off, then a **Retry** button. Clips already
  confirmed by Drive are not re-sent. Success only after all clips are confirmed.
* `submissionId` = `roopa60-<ms timestamp>-<guest-slug>` shared by a guest's three rows.
* Filenames: `NN-firstname-lastname-YYYY-MM-DDTHH-MM-SS.<ext>` where `NN` is the prompt ID.
  The server builds the name itself (never trusts the browser) and preserves the real
  extension (`.webm`, `.mp4`, `.mov`, …).

### Payload size vs. Apps Script limits (investigated)
Google documents no hard cap for inbound `doPost` bodies; the 50 MB figure applies to
`UrlFetchApp` and to `DriveApp.createFile`. Multi‑MB JSON posts to Apps Script are
common and reliable. At 1.2 Mbps + 96 kbps a 10 s clip is **≈1.6 MB raw / ≈2.2 MB
base64** (Chrome Android, 720p). iOS Safari ignores the bitrate hint and produces
≈3–6 MB for 10 s of 720p H.264 → ≈8 MB base64. Both are far below the limit, so no
resolution reduction was needed. `Code.gs` rejects anything over 40 MB with a clear
error rather than letting Drive fail.

### Nice-to-haves included
`beforeunload` guard while clips are unsubmitted · total upload size estimate · camera
preview on/off toggle · subtle screen dim while recording · 3‑2‑1 countdown with soft
tick · CSV export of generated links · QR code per link (own 200‑line encoder, verified
bit-for-bit against a reference implementation).

---

## Admin link generator (`/?admin=1`)

First name, last name, relationship, pick exactly 3 questions (numbered in the order
you tick them) → **Generate link**. You get the link, a copy button, the WhatsApp
message with **Copy Message**, a QR code (download as PNG), a `guests.js` snippet, and
**Add to list** → **Export CSV**. The list is saved in that browser's `localStorage`.

If the slug already exists in `guests.js` the link is short (`?guest=…&q=…`); otherwise
the name/relationship are embedded as `fn`/`ln`/`rel` so the guest is greeted by name
without you touching the repo. Untick *Include name in the link* if you'd rather add
the snippet to `guests.js` and keep links minimal.

---

## Local development

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000/?guest=ravi-shah&demo=1>. `localhost` counts as a
secure context, so the camera works. There is nothing to build or install.

To point a local page at a real backend without editing the file, run in the console:
`ROOPA60_CONFIG.APPS_SCRIPT_URL = "https://script.google.com/macros/s/…/exec"`.

---

## Test checklist

| # | Where | What to check |
|---|---|---|
| 1 | Chrome desktop | Full flow with `?demo=1`; webcam preview; auto-stop at 10 s; Stop early; playback scrubber works; review; submit → thank-you. |
| 2 | Chrome Android (open from WhatsApp) | Link opens in Chrome or a Chrome custom tab; front camera; permission prompt only after *Enable Camera*; upload completes; files appear in Drive with `.webm`. |
| 3 | Safari iPhone (open from WhatsApp) | iOS ≥ 14.5: inline recording, `.mp4` files land in Drive. Older iOS: fallback button opens the Camera app; `.mov` uploads. Check nothing autoplays with sound. |
| 4 | Retake | Retake during playback, and Retake from the review page → returns to review afterwards; only the new clip is uploaded. |
| 5 | Upload failure | Turn on airplane mode before *Submit*: see "didn't go through" + **Retry**; turn network back on → Retry → success; no duplicate rows for clips that already succeeded. |
| 6 | Unknown guest | `/?guest=whoever` → name form → default prompts 1, 2, 3; the sheet row has the typed name and slug. |
| 7 | Custom prompt link | `/?guest=ravi-shah&q=1,4,5` shows prompts 1, 4, 5 in that order; `q=99,abc` falls back to the configured prompts. |
| 8 | Very slow connection | Chrome DevTools → Network → *Slow 3G*: progress bar moves, nothing times out below 2 min, status text is honest. |
| 9 | Admin | `/?admin=1`: exactly-3 enforcement, Copy link / Copy Message, QR scans with the phone camera, CSV opens in Excel/Numbers. |
| 10 | Backend | `selfTest()` in the Apps Script editor writes a file + row; `curl` test in `google-apps-script/README.md`. |

### Before sending links: test on a real iPhone
1. Open your own link **from WhatsApp**, not from Safari directly. Confirm it opens in a browser that allows the camera (if it opens inside an in-app browser and the camera is refused, the fallback button must appear — try it).
2. Tap **Enable Camera** → iOS permission sheet → front camera preview appears (mirrored is correct).
3. Record a full 10 s answer; make sure the auto-stop happens and the playback has sound.
4. Lock the phone mid-recording, unlock: the app should drop back to *Record Answer* without crashing.
5. Submit all three, then check Drive: three `.mp4` files in the right `Prompt NN` folders, playable, with audio; three sheet rows sharing one Submission ID.
6. Try the back-swipe gesture before submitting: Safari should warn you.
7. Low Power Mode on: video still records.

---

## Known limitations

* **Bitrate hints are advisory.** Safari ignores `videoBitsPerSecond`; iOS clips are larger (still well within limits).
* **In-app browsers.** Some apps (Instagram, Facebook, some older WhatsApp builds on Android) block the camera inside their web view. The fallback file input covers this; the error message also suggests opening in Safari/Chrome.
* **No upload resume.** If the page is closed before all uploads finish, unsent clips are lost — the `beforeunload` warning is the only guard. Clips already confirmed remain in Drive.
* **Duplicates on edge-case retries.** If a request succeeds server-side but the response is lost, a retry stores a second copy. Harmless; dedupe by Submission ID + Prompt Number in the sheet.
* **WebM on Apple devices.** Chrome recordings are `.webm`; QuickTime won't open them. VLC, Chrome, or Drive's own preview will. Convert later with `ffmpeg` if you edit in iMovie/Final Cut.
* **Admin page is unauthenticated** by design — it only builds URLs. The upload endpoint accepts anonymous posts by design too; the worst case is junk files in your folder.
* **Single Apps Script deployment URL.** Re-deploy as a *new version* after editing `Code.gs`.
* Recordings never touch any third-party service; the only hosts involved are GitHub Pages and Google.
