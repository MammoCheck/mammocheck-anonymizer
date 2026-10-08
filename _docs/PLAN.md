# MammoCheck Anonymizer — plan

## Context
Doctor keeps one folder per patient (folder name = patient full name, e.g. `_example/Jane Doe/`). Contents seen in `_example/`:
- FLIR E85 thermal JPGs (`FLIR####.jpg`) — EXIF only camera/date, embedded radiometric data (must keep bytes intact).
- PDFs: text-based (`Med. F-Thermo J.Doe.pdf`, `Body Anamnesis Form.pdf`, `Shoulder test.pdf`, Crystal Reports lab `jane doe.pdf`) and scanned (`Medical File (…).pdf`). Name appears in variants: `J.Doee`, `JANE . DOE`, `Jonathan, Doe`. PDF metadata has authors/clinic.
- DOCX forms (`Body Anamnesis Form.docx`, `Daily Tx(J.Doe).docx`): name, DOB, address, phone, email in text; docProps author.
- JPG scans of forms (`Body Anamnesis Form_Page_1.jpg`, `Pain Form .jpg`, `Screenshot_3.jpg`, WhatsApp images) — PII only in pixels (incl. handwriting).
- Junk: `Thumbs.db`, `.DS_Store`, `~$*.docx` lock files. One `.mp4`.

Goal: send doctor a link → he selects his patients folder → browser anonymizes everything automatically (no manual review) keeping all clinical info (diagnoses, age, gender, history, reports, dates), removing only names + contact details → uploads to one Google Drive folder configured via env. Raw PHI never leaves his PC.

Decisions (from user): Cloudflare Worker holds Drive creds; fully automatic redaction; keep clinical data incl. dates; random patient IDs + local key file.

## Architecture
```
GitHub Pages (static UI, Vite+TS)  ──POST /folder, /session (X-Upload-Key)──►  Cloudflare Worker (env secrets)
   │  all anonymization in browser (Web Workers, WASM)                         │ refresh token → access token
   └──── PUT chunks directly to Drive resumable upload URL ◄───────────────────┘ creates resumable session (Origin set)
```
- MammoCheck org is on **free plan → Pages needs a public repo**. Fine: no secrets in frontend. `_example/` must be git-ignored (real patient data).
- New repo `MammoCheck/mammocheck-anonymizer` (public), this dir as root.

## Repo layout
```
web/                     Vite + vanilla TypeScript
  src/main.ts            UI: pick folder, patient list, progress, key download
  src/scan.ts            folder → patients detection
  src/names.ts           name-variant + fuzzy matcher, PII regexes
  src/process/pdf.ts     mupdf.js (WASM) text search + real redaction, OCR fallback for scanned pages
  src/process/image.ts   tesseract.js OCR → black boxes, canvas re-encode (strips EXIF)
  src/process/docx.ts    JSZip: replace text in word/*.xml, wipe docProps
  src/process/flir.ts    pass-through + byte scan for name strings
  src/leakcheck.ts       final gate: re-extract text from output, block file on any hit
  src/upload.ts          Worker client + chunked resumable PUT, retries
  src/key.ts             mapping CSV load/save
  src/worker.ts          Web Worker running processors
worker/                  Cloudflare Worker (TS, wrangler)
  src/index.ts           /folder, /session, /health
  wrangler.toml
.github/workflows/pages.yml   build web/ → deploy Pages (VITE_WORKER_URL as repo variable)
README.md                setup: Google OAuth refresh token, wrangler secrets, link format
```

## Anonymization rules
1. **Patient detection (flexible)**: selected root with only files → one patient. Otherwise each top-level subfolder = one patient; deeper subfolders kept (names sanitized). Name = folder name; UI shows editable name per patient + optional extra terms field (prefilled, no review needed to proceed).
2. **Name variants** from name parts (≥3 chars): full name, each part, `F.Last`, `F. Last`, `Last, First`, spaced letters (`J A N E`, `JANE . DOE`), case-insensitive; fuzzy match tokens ≥5 chars with Levenshtein ≤1 (catches `DOEE`, `Doee`). Plus names harvested from `Name:` fields in that patient's DOCX/PDF text are added to the variant list.
3. **Contact PII regexes**: phone numbers (≥7 digits, intl prefixes), emails, DOB lines (`Date of birth` value), address/postal/city line values, national/patient IDs after `ID:` / `Patient ID` labels. **Label-anchored redaction**: when a label (`Name`, `Date of birth`, `Address`, `Phone`, `Mobile`, `Email`, `ID`) is found (text or OCR), redact the value area to the right on that line — catches handwriting OCR misses. Clinical text, age, gender, dates of exam kept.
4. **Per type**:
   - FLIR JPG (EXIF make = FLIR): untouched bytes (keeps radiometric data); byte-scan for name strings → if found, block.
   - Other images (jpg/png/heic→jpg): OCR (tesseract.js, eng) → black boxes on matches + label rows → re-encode via canvas (EXIF/GPS stripped).
   - PDF: mupdf.js: per text line, name variants/PII regexes/label values → `Redact` annotation + `applyRedactions` (true removal, rest of text kept; rects shrunk to the line's central band because mupdf removes any glyph a rect touches). Pages with no text layer or mostly-image pages → render 200dpi → OCR (2 passes) → redaction rects applied to the page (image pixels blacked out, hidden text layer removed; page is not rebuilt). Strip Info/XMP/PieceInfo/bookmarks, clear form field values with PII + flatten, drop annotations/links carrying names. Gate re-runs redaction (max 3 rounds) before blocking.
   - DOCX/XLSX/TXT/CSV: replace hits with `[REDACTED]` in XML/text; clear `docProps/core.xml` creator/lastModifiedBy.
   - Video (`.mp4 .mov .avi .m4v .3gp .mkv .webm .wmv .mpg .mpeg`): **included, bytes passed through unchanged** (no re-encode). Filename: name variants → ID. Same streamed byte-scan for name strings as FLIR (read via `Blob.slice` in 4 MiB chunks, never the whole file in memory); hit → blocked. `manifest.json` records "included, not content-anonymized (faces/voice may be present)". Upload streams from the `File` in chunks (`Blob.slice`).
   - Junk (`Thumbs.db`, `.DS_Store`, `~$*`, `desktop.ini`): dropped.
   - Unknown types: skipped + reported.
5. **Filenames/subfolders**: name variants replaced with patient ID (`Med. F-Thermo J.Doe.pdf` → `Med. F-Thermo MC-7F3K2Q.pdf`).
6. **Leak gate (automatic)**: after processing, re-extract text (mupdf text / docx xml / OCR result of redacted image) and search variants again; any hit → file not uploaded, flagged in report. Replaces manual review.

## IDs + key
- ID `MC-` + 6 random base32 chars (crypto.getRandomValues).
- Doctor downloads `mammocheck-key-<date>.csv` (name, ID, original folder) — never uploaded. No key loading: every run assigns new IDs.
- Upload per patient: `DRIVE_ROOT/MC-7F3K2Q/...` + `manifest.json` (file list, actions taken, skipped files, no names).

## Worker (env)
Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (scope `drive`), `DRIVE_FOLDER_ID`, `UPLOAD_KEY`, `ALLOWED_ORIGIN` (Pages URL).
- `POST /folder {path[]}` → find-or-create nested folders under root, returns id (serialized per patient from browser to avoid duplicates).
- `POST /session {parentId, name, mimeType, size}` → verify parent is under root, create resumable session with `Origin: ALLOWED_ORIGIN`, return `Location` URL. Skips if same name+size exists (re-run safe).
- Auth: `X-Upload-Key` must equal `UPLOAD_KEY`. Link sent to doctor: `https://mammocheck.github.io/mammocheck-anonymizer/#k=<UPLOAD_KEY>` (fragment → not logged by servers).
- File bytes never pass through Worker (no size limits).

## UI flow (single page)
1. Drop/select folder (`webkitdirectory` + drag-drop). 2. Detected patients list (editable names, optional key file load). 3. "Anonymize & upload" → per-file progress, concurrency 3. 4. Report (uploaded / blocked / skipped) + key CSV download. Dev option `?zip=1`: download ZIP instead of upload (for testing; holds data in memory, small data only).

## Verification
- `vitest`: name variants & fuzzy (`DOEE`, `J.Doee`, `Jonathan, Doe` matched; clinical words like `Endometriosis` not), patient detection on 3 layouts, filename rewrite, regexes.
- Run locally (`npm run dev`, `?zip=1`) on `_example/`; then on output: `pdftotext` + `grep -i` for names/phone/email, `unzip -p *.docx word/document.xml | grep`, confirm FLIR files byte-identical (`cmp`), view redacted form JPGs.
- Worker: `wrangler dev` + test folder ID → upload `_example` output, check Drive tree.
- Deploy: push repo, Pages action green, Worker `wrangler deploy`, end-to-end with real link.

## Known limits (tell user)
- Handwritten names on scanned forms rely on label-anchored boxes; OCR not perfect.
- Faces in photos not detected. Videos are uploaded as-is (only filename + byte-scan for names): faces/voice/burned-in text are NOT anonymized; the manifest says so.
- mupdf.js is AGPL — OK since repo public.
