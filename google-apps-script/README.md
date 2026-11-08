# Google Apps Script backend

`Code.gs` is the whole backend: one `doPost(e)` that saves a base64 video to
Google Drive and appends a row to a Google Sheet. Nothing is stored in the
script itself.

## Setup (≈10 minutes)

1. **Drive folder** – create a folder (e.g. `Roopa 60 Videos`). Open it and copy the
   ID from the URL: `https://drive.google.com/drive/folders/<FOLDER_ID>`.
2. **Sheet** – create a Google Sheet (e.g. `Roopa 60 Submissions`). Copy the ID from
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`. The header row is
   created automatically on first run (or by `setup()`), so you don't need to type it.
3. **Apps Script project** – go to <https://script.google.com> → **New project**.
   Replace the contents of `Code.gs` with this repo's `Code.gs`. Name the project.
4. Fill in the two constants at the top:
   ```js
   const DRIVE_FOLDER_ID = "…";
   const SHEET_ID = "…";
   ```
5. In the editor choose the function **`setup`** in the toolbar and press **Run**.
   Approve the permission prompt (Drive + Sheets). The log should show
   `Drive folder OK`, `Prompt folders OK`, `Sheet OK`.
6. Optionally run **`selfTest`** – it writes a tiny file into `Prompt 01` and a row
   into the sheet. Delete both afterwards.
7. **Deploy** → **New deployment** → gear icon → **Web app**:
   * Description: `roopa60 v1`
   * Execute as: **Me** (your account owns the files; guests never sign in)
   * Who has access: **Anyone** (required for anonymous guest uploads)
   * **Deploy**, then copy the **Web app URL** (ends in `/exec`).
8. Paste that URL into `CONFIG.APPS_SCRIPT_URL` in `app.js`, commit, push.
9. Open the Web app URL in a browser – you should see `{"ok":true,"service":"roopa60-upload",…}`.

### Updating the script later
Edit the code, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
The URL stays the same. (Saving alone does *not* update the live `/exec` URL.)

## Test with curl

```bash
curl -L -X POST "https://script.google.com/macros/s/XXXX/exec" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data '{"submissionId":"roopa60-curl-test","guest":{"slug":"curl-test","firstName":"Curl","lastName":"Test","relationship":"Test"},"prompt":{"id":1,"text":"curl test"},"filename":"01-curl-test.webm","mimeType":"video/webm","durationTarget":10,"data":"aGVsbG8="}'
```

`-L` matters: Apps Script answers with a 302 to `script.googleusercontent.com`.
Browsers follow it automatically.

## Why `Content-Type: text/plain`?

Apps Script web apps do not answer CORS pre-flight (`OPTIONS`) requests. A
`text/plain` POST is a "simple request" so the browser skips the pre-flight, and
the redirected response carries `Access-Control-Allow-Origin: *`. The body is
still JSON; the script simply `JSON.parse`s `e.postData.contents`.

## Limits that matter

| Limit | Value | Why we are fine |
|---|---|---|
| `DriveApp.createFile` blob size | 50 MB | clips are ~1–3 MB |
| Inbound POST body | no documented cap; multi‑MB JSON bodies are widely used | base64 of a clip is ~2–4 MB |
| Script execution time | 6 min per request | a 3 MB decode + Drive write takes ~2–5 s |
| Simultaneous executions | 30 | each upload is a few seconds; 3 clips upload sequentially |
| Daily triggers / quotas | Drive create: 250 000 /day | not a concern |

`MAX_FILE_BYTES` (40 MB) rejects anything unexpectedly large with a clear error
before Drive would.

## Privacy

* Files inherit the folder's permissions – private to you unless you share the folder.
* No `setSharing()` calls, no public links.
* The Drive URL written to the sheet requires your Google login.
* The only public value is the Web app URL itself; it can only *add* files.
