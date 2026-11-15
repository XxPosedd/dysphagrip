# Architecture decisions

- Use React/Vite/TypeScript for the dashboard.
- Use Express/TypeScript for API endpoints.
- Use Neon Postgres for session metadata and event records.
- Keep ElevenLabs and Bright Data calls server-side.
- Treat MPU-6050 as mount-motion sensing only until validated.
- Do not implement or label a medical classifier.

## Phase 1–2 (audio)

- **Audio capture moves from the browser to a local Python service.** The UM2 + CM-300 path
  needs explicit device and channel selection, and a predictable sample clock for synchronisation
  with motion data. The starter's browser `getUserMedia` meter is superseded and will be replaced in Phase 5.
- **FastAPI + uvicorn** for the audio service: REST control and WebSocket streaming in one process,
  testable with `TestClient`.
- **sounddevice** (PortAudio) over PyAudio: ships binary wheels with PortAudio for macOS and Windows,
  so there is no Homebrew step.
- **Frames, not raw audio, go over the wire**: about 50 ms frames with a 200-point min/max envelope, a
  128-bin spectrogram column and features (about 3 KB/frame). Raw audio is never sent to the backend or stored.
- **Timestamps are sample-clock based** (anchor + index/fs) rather than per-block wall clock; drift
  versus the wall clock is exposed, not hidden (see services/audio/README.md).
- **WAV playback is a labelled fallback** (`source: "file"`), so a pre-recorded demo can never be
  shown as live.
- **Quality rules are simple and explainable** (no_signal / clipping / mains_hum), with
  thresholds in `config.py`. No accuracy figures are claimed.
- The audio WebSocket only accepts localhost dashboard origins.

## Phase 5 (dashboard)

- **Canvas rendering outside React state.** Frames arrive at 20 Hz; canvases subscribe directly and
  redraw in `requestAnimationFrame`. Numeric panels update at about 8 Hz. This keeps React re-renders cheap.
- **Session logic is a pure class** (`SessionRecorder`) with unit tests: timeline points, activity
  segmentation (≥150 ms on, bridged gaps < 200 ms, max 10 s), quality debouncing (≥1 s) and summaries.
- **Session time uses the audio sample clock** (frame `t_end_unix_ms`) relative to the browser's start
  time. Both run on the same MacBook clock; cross-device sync is Phase 4.
- **Colour follows the data-viz rules**: a single-hue sequential ramp for the spectrogram (no rainbow),
  auto-ranged with a 70 dB span; reserved status colours, always with an icon and label, for quality;
  validated categorical slots 1–3 for X/Y/Z and for series identity. Light and dark modes are each selected.
- **The quality strip and voice cues use the debounced label**; the session summary's time-by-quality
  uses raw per-frame labels (the accurate time split).
- **No silent fallbacks**: the browser's built-in speech synthesis is not used in place of ElevenLabs, and the
  motion panel shows "Not connected" rather than placeholder numbers.
- An error boundary keeps a rendering error from blanking the dashboard mid-demo.

## Phase 6 (Neon)

- **Fresh schema instead of migrating the starter's tables.** The starter's `sessions`/`events` tables were
  never deployed (there was no `DATABASE_URL`), and the old `events` CHECK constraint used unwanted
  labels. New tables: `recording_sessions` (UUID), `session_markers`, `session_quality`. All DDL is idempotent.
- **UUIDs are generated server-side**, so the session row, bulk markers (`unnest`) and quality rows go into
  **one non-interactive Neon HTTP transaction**. A failed save leaves nothing behind.
- **A `SessionStore` interface sits between routes and Neon.** Route tests use an in-memory test store;
  `npm run test:db` exercises the real Neon store.
- **Strict server-side validation** (no extra dependency): whitelisted marker kinds, finite numbers, ISO
  timestamps, end ≥ start, length limits (label 120, note 280), at most 5000 markers. The database also enforces CHECK
  constraints as a second line.
- **A contract test** builds a payload from a real `SessionRecorder` in the web code and runs it through the
  server's validator, so the two sides cannot drift silently.
- **Connection strings are redacted** from every error returned to clients or logged.
- **Saves are explicit about failure**: a failed save keeps the session in the tab with "Save failed" and
  "Retry save", and is announced. It is never shown as saved.
- **Neon project linked with the official CLI** (`neon init`, Neon's agent setup instructions). The app's
  runtime uses only `DATABASE_URL` (pooled; the serverless HTTP driver). `neon.ts`, `@neon/config` and `@neon/env`
  were added by `neon init` for Neon's own branch/config tooling; the app code does not import them.
  `.neon` (project link) is git-ignored.

## Phase 7 (ElevenLabs)

- **Allowlisted phrases only.** `POST /api/voice/status` speaks one of a fixed set of operational phrases
  (`server/src/voice/phrases.ts`) and rejects any other text. This protects the ElevenLabs quota on a public demo and
  guarantees no clinical wording; a test fails the build if a phrase mentions aspiration, diagnosis, safety of swallowing, etc.
  A contract test keeps the dashboard's phrase list identical to the server's.
- **Server-side cache + in-flight de-duplication**: each phrase is generated once per server process and replayed
  (`X-Voice-Cache: hit|miss`). Repeated cues cost nothing and play instantly.
- **Rate limit on uncached calls** (30/min) and a 15 s timeout; ElevenLabs errors (401 bad key, 404 voice, 429 quota,
  timeouts) are mapped to clear messages that never include the key.
- **Model**: `eleven_multilingual_v2` (ElevenLabs' documented default), overridable with `ELEVENLABS_MODEL_ID`;
  output `mp3_44100_128` (available on every plan).
- **No silent fallback** to browser speech synthesis: when ElevenLabs is not configured or fails, announcements are shown as
  text and labelled 💬, so the demo never implies ElevenLabs is speaking when it isn't.
- **Autoplay**: the first cue ("Recording started.") follows the Start-session click, a user gesture, so browsers allow playback.
  If playback is blocked anyway, the panel says so.

## Phase 8 (Bright Data)

- **US public-domain sources only, vetted before collection** (2026-11-14): permission/licence, robots.txt, absence of bot
  challenges, and no intervention advice in the official description. Rejected sources and reasons are recorded in
  `server/src/resources/sources.ts`.
- **Bright Data where it is the right tool, official APIs where they exist.** NIDCD pages have no API, so they go through
  Bright Data's Web Unlocker API (`POST https://api.brightdata.com/request`, `format: raw`). MedlinePlus has an official
  web service, so it is used directly. Each record states how it was collected.
- **Never bypass protections.** The Bright Data client only accepts vetted hosts (`www.nidcd.nih.gov`), and any page that
  comes back as a bot challenge is skipped and reported. We do not use Web Unlocker to get past a site's defences.
- **No invented content.** Summaries are the publisher's own description or first paragraph, trimmed; a page with no
  description is refused rather than summarised by us.
- **Collection is a CLI job** (`npm run resources:refresh`), not an API route, to protect the Bright Data balance and keep
  the public site read-only. Upserts are keyed on `source_url`.
- **Attribution in the UI**: publisher, link, collection method, retrieval date, source date (when stated), licence note,
  and a "not advice from DysphaGrip" notice. English and Spanish entries can be filtered.
- Tests run against real saved pages (public domain), so the suite never spends Bright Data credits.

### Phase 8 update: sources after live testing

- Live finding: **Bright Data refuses government websites** (HTTP 200 with an empty body and `x-brd-error: … classified as
  Government and blocked by Bright Data …`; its docs say government sites are blocked on all networks, and KYC does not
  guarantee access). The NIDCD pages were dropped; government content stays via the MedlinePlus API.
- Replacement sources were vetted the same way (terms, robots.txt, bot protection, relevance, description wording) plus a
  **live Bright Data test fetch**. 19 US sources were checked; Parkinson's Foundation (2 pages) and SPOHNC (1 page) passed.
- These pages are copyrighted, so only title, the publisher's own description, dates and URL are stored and shown with
  "© publisher · linked". Test fixtures keep only each page's `<title>`/`<meta>` tags, not the body.
- Client fix: a 200 response carrying `x-brd-error`, or an empty body, is now an error rather than a "page". The parser
  ignores markup inside HTML comments.
