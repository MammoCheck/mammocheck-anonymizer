# MammoCheck Anonymizer

A doctor opens a link, selects the folder that contains his patients' folders, and the browser anonymizes everything
**on his own computer**; only the anonymized copies are uploaded to one Google Drive folder. Original files never leave his PC.

```
GitHub Pages (static UI)  --POST /folder, /session (X-Upload-Key)-->  Cloudflare Worker (holds Google credentials)
   |  all anonymization in the browser (Web Worker, WASM)                 | creates folders + resumable sessions
   '--- PUT chunks directly to the Drive session URL <--------------------'  (file bytes never pass through the Worker)
```

- `web/` Vite + vanilla TypeScript static app (mupdf WASM, tesseract.js, JSZip).
- `worker/` Cloudflare Worker (`/health`, `/folder`, `/session`).
- `_docs/PLAN.md` the design/spec. `_example/` is **real patient data**, git-ignored: never commit or copy it.

## What it does per file

| Type | Treatment |
|---|---|
| FLIR thermal JPG (EXIF make FLIR) | bytes untouched (radiometric data kept), scanned for name strings (blocked if found) |
| Video (mp4, mov, avi, m4v, 3gp, mkv, webm, wmv, mpg) | **included, bytes untouched**, streamed byte-scan for name strings, filename rewritten; manifest says "included, not content-anonymized (faces/voice may be present)" |
| Other images | OCR, black boxes over names / contact details / label values, re-encoded (EXIF/GPS dropped) |
| PDF | real redaction with mupdf (text removed from the file, image pixels blacked out), scanned pages via OCR, metadata/XMP/bookmarks removed, form fields cleared |
| DOCX / XLSX | text replaced with `[REDACTED]`, document properties wiped |
| TXT / CSV | text replaced |
| `Thumbs.db`, `.DS_Store`, `~$*`, `desktop.ini` | dropped |
| anything else | skipped and listed in the report |

Names: folder name -> variants (`F.Last`, `Last, First`, `J A N E`, upper/lower case, accents) + fuzzy matching (edit distance 1 on
tokens of 5+ letters, so `SMITHSAN` / `Brownn` are caught but `Endometriosis` is not). Names found in `Name:` fields that share a token
with the folder name are added automatically. Label-anchored redaction removes the value after `Name`, `Date of birth`, `Address`,
`Phone`, `Mobile`, `Email`, `ID`, `File No`, `MRN`... Clinical text, age, gender and exam dates are kept.
A **leak gate** re-checks every output (text layer, OCR of the output image, raw bytes); a failing file is **not uploaded** and is listed in the report.
File names have name variants replaced by the patient ID (`Med. F-Thermo R.Smithson.pdf` -> `Med. F-Thermo MC-7F3K2Q.pdf`).
Each patient gets a random ID `MC-XXXXXX` and a `manifest.json` (files, actions, skipped/blocked; no names). The doctor downloads
`mammocheck-key-<date>.csv` (name <-> ID); it is never uploaded. Every run assigns new IDs (a returning patient gets a new ID).

## Setup

### 1. Google Drive + OAuth client

1. Create (or pick) the Drive folder that will receive the data. Open it and copy the **folder ID** from the URL
   (`https://drive.google.com/drive/folders/<FOLDER_ID>`). The Google account used below must own the folder or be an editor.
2. [Google Cloud Console](https://console.cloud.google.com/) -> create a project -> **APIs & Services -> Library -> Google Drive API -> Enable**.
3. **OAuth consent screen**: user type External, fill the basics, add the Google account as a test user, then **Publish app**
   ("In production"). Apps left in *Testing* get refresh tokens that **expire after 7 days**. An unverified app is fine for one private account.
4. **Credentials -> Create credentials -> OAuth client ID -> Web application**. Add the authorized redirect URI
   `https://developers.google.com/oauthplayground`. Note the **client ID** and **client secret**.

### 2. Refresh token (OAuth Playground)

1. Open <https://developers.google.com/oauthplayground>, click the gear icon, tick **Use your own OAuth credentials**, paste the client ID and secret.
2. In Step 1 enter the scope `https://www.googleapis.com/auth/drive` (type it in the input box), **Authorize APIs**, sign in with the account that owns the folder.
3. Step 2: **Exchange authorization code for tokens**; copy the **Refresh token**.

### 3. Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy                       # note the https://mammocheck-anonymizer.<subdomain>.workers.dev URL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put DRIVE_FOLDER_ID
npx wrangler secret put UPLOAD_KEY        # a long random string, e.g. `openssl rand -hex 24`
npx wrangler secret put ALLOWED_ORIGIN    # the Pages origin, e.g. https://mammocheck.github.io (no path)
curl https://<worker-url>/health          # -> {"ok":true,"configured":true}
```

`ALLOWED_ORIGIN` may list several origins separated by commas (e.g. add `http://localhost:5173` for local tests).
CORS is limited to those origins and every call needs the `X-Upload-Key` header.

### 4. GitHub Pages

1. Push this repo (public; Pages needs a public repo on the free plan; there are no secrets in it). Keep `_example/` out (it is in `.gitignore`).
2. **Settings -> Pages -> Source: GitHub Actions**.
3. **Settings -> Secrets and variables -> Actions -> Variables**: add `VITE_WORKER_URL` = the Worker URL (no trailing slash).
4. Push to `main` (or run the workflow). `.github/workflows/pages.yml` runs the tests, builds `web/` with `VITE_BASE=/<repo>/` and deploys.

### 5. Link for the doctor

```
https://<org>.github.io/<repo>/#k=<UPLOAD_KEY>
```

The key sits in the URL fragment, so it is not sent to any server or logged. Anyone with the link can upload into the Drive folder
(and nothing else): rotate it with `wrangler secret put UPLOAD_KEY` if it leaks.

## Development

```bash
cd web && npm install
npm run dev                  # http://localhost:5173/?zip=1 -> downloads a ZIP instead of uploading
npm test                     # vitest
npm run build                # tsc + vite build (reads VITE_WORKER_URL, VITE_BASE)
npx tsx scripts/verify.ts <input-folder> <out-dir-outside-the-repo> [--no-ocr]   # runs the real pipeline in Node
cd ../worker && npm run typecheck && npx wrangler dev   # needs .dev.vars with the six variables
```

Core logic (`names.ts`, `scan.ts`, `pipeline.ts`, `process/*`) has no DOM dependency and runs in Node; the browser supplies the image codec
(`imageio.ts`), the Node script uses `@napi-rs/canvas`.

## Known limits

- **Handwriting** on scanned forms is not read by OCR; it is only covered by the label-anchored boxes (value area right of `Name`, `Date of birth`, ...). Check a few results.
- OCR is imperfect (tables, colored text, photos): two OCR passes are used and the output is OCR'd again as a leak gate, but it can miss text. Scanned/photographed PDFs and images are the weakest part.
- **Faces and voices are not anonymized.** Photos are not inspected for faces. **Videos are uploaded as-is** (only the filename and a byte-scan for name strings), so they may contain faces, voices or on-screen text; the manifest marks them.
- Embedded images in DOCX/XLSX are not anonymized (the manifest notes how many were present). Old binary `.doc/.xls`, `.tif`, etc. are skipped.
- Other people's names (referring doctors, relatives) are kept unless they sit behind a `Name`-type label; contact details (phones, emails) are removed wherever they appear.
- Very large videos: the byte-scan is case-insensitive on names of 5+ letters at word boundaries; a spurious match in a multi-GB file is possible and would block that file (listed in the report).
- `?zip=1` keeps everything in memory (test mode, small data). The browser must stay open during upload; re-running skips files already in Drive (same name and size).
- HEIC/HEIF only decode in browsers that support it (Safari); otherwise those files are skipped.
- The first OCR run downloads the English language data (~10 MB) from the tesseract.js CDN; this contains no patient data.
- mupdf is AGPL-licensed; that is fine because this repo is public, keep it public/AGPL-compatible.
