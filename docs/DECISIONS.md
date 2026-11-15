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
