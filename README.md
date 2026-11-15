# DysphaGrip: Experimental Swallowing-Signal Monitor

A real-time dashboard that captures **contact-microphone audio** (KORG CM-300 → Behringer UM2) and
**neck-mount motion** (Arduino UNO Q + MPU-6050), synchronises them on one session clock, and
shows waveform, spectrogram, motion, signal quality and experimental event markers.

> **Safety and claims:** This is an experimental engineering prototype, **not a medical device**.
> It does not diagnose dysphagia and does not detect aspiration, silent aspiration or pharyngeal
> residue. It cannot confirm that swallowing is safe. It must not be used for feeding,
> treatment or emergency decisions. Demos use consenting healthy volunteers and ordinary,
> comfortable activity only. See [docs/SAFETY_AND_CLAIMS.md](docs/SAFETY_AND_CLAIMS.md).

## Sponsor tracks

| Track | Contribution | Status |
|---|---|---|
| Best Overall Hack | End-to-end live audio + motion capture, synchronised dashboard, signal quality, history | Audio service ✅ · dashboard ✅ (audio) · motion 🚧 |
| Bright Data: Data for Good | Attributed US public-domain swallowing resources (NIH NIDCD via Bright Data Web Unlocker; MedlinePlus EN/ES via official API) with source, publisher, licence and retrieval date | ✅ Built and tested · MedlinePlus live · NIDCD collection pending Bright Data token |
| ElevenLabs | Spoken status: "Recording started", "Audio signal detected", "Movement interference detected", "Session saved successfully" | ✅ Live: voice "Matilda", spoken cues verified in the dashboard |
| Neon | Sessions, event markers, signal-quality summaries in Neon Postgres | ✅ Live: project `restless-shape-44821324`, migrated, round-trip test and dashboard save verified |

An integration is only claimed once it is implemented, tested and visible in the demo.

## Architecture

```text
KORG CM-300 → UM2 ─USB─► services/audio (Python: sounddevice, NumPy, SciPy, FastAPI)
                              │  WebSocket :8765  audio_frame (waveform, spectrogram column, features, quality)
                              ▼
Arduino UNO Q + MPU-6050 ─USB serial─► motion receiver (Phase 3)
                              │
                              ▼
                    apps/web (React + Vite + TS) ◄──► server (Express + TS) ──► Neon Postgres
                                                           ├──► ElevenLabs TTS
                                                           └──► Bright Data
```

## Repository structure

```text
apps/web/                 React dashboard (Vite, TypeScript)
server/                   Express API: sessions, voice, resources; vitest tests
  scripts/migrate.ts      applies src/schema.sql to Neon
services/audio/           Python audio service (see its README)
  dysphagrip_audio/       devices, capture, dsp, processor, server, CLI, static viewer
  tests/                  pytest suite
hardware/
  audio_um2_cm300/        UM2 + CM-300 wiring and settings
  unoq_mpu6050/           motion sensor notes (firmware in Phase 3)
docs/                     decisions, open questions, safety, demo script
.vscode/                  launch configs and tasks
```

## Run locally (VS Code)

Requirements: Node.js 20+, Python 3.10+ (verified on 3.14), Git.

```bash
# 1. JavaScript dependencies
npm install
npm run install:all

# 2. Python audio service
cd services/audio
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ../..

# 3. Environment (all integrations optional)
cp .env.example .env
```

Run the pieces (two terminals, or use the VS Code *Run and Debug* configs):

```bash
# Terminal 1: audio service; viewer at http://127.0.0.1:8765/
cd services/audio && source .venv/bin/activate
python -m dysphagrip_audio serve --device um2 --channel 1 --autostart

# Terminal 2: API + web dashboard at http://localhost:5173
npm run dev
```

## Dashboard

Open http://localhost:5173 with the audio service and `npm run dev` running.

| Area | What it shows |
|---|---|
| Status chips | Audio service, motion, Neon, ElevenLabs, Bright Data, each reported as connected/configured or not |
| Controls | Input device (UM2 auto-selected when found), channel, start/stop input, **Start/Stop session**, session timer |
| Waveform | Last 5 s, auto-scaled min/max envelope |
| Spectrogram | Last 15 s, 0–4 kHz, single-hue scale auto-ranged to the background; hover for frequency/dB |
| Signal quality | Debounced OK / No signal / Clipping / Mains hum with reasons, level, floor, dominant frequency, hum, band energy |
| Movement | MPU-6050 accel/gyro X/Y/Z. Shows "Not connected" (no fake values) until Phase 3 |
| Session timeline | Whole session or last 30 s: level and noise floor, audio-activity segments, manual markers, quality strip, motion lane; hover crosshair |
| Event markers | Manual markers (button or **M** key), automatic *audio activity (experimental)* segments, quality episodes |
| Voice feedback | "Recording started", "Audio signal detected", quality warnings, "Session saved successfully". Always shown as text; spoken via ElevenLabs once configured |
| Session history | Per-session summary (duration, activity, markers, median floor, time-by-quality). Kept in the browser tab until Neon (Phase 6) |

Keyboard: **M** adds a manual marker during a session.

## ElevenLabs (voice feedback)

1. Create an API key at [elevenlabs.io](https://elevenlabs.io) (*profile → API Keys*) and pick a voice (*Voices → copy voice ID*).
2. Add to `.env`: `ELEVENLABS_API_KEY=…` and `ELEVENLABS_VOICE_ID=…` (optional `ELEVENLABS_MODEL_ID`, default `eleven_multilingual_v2`).
3. Restart the API. The **ElevenLabs** chip turns green; use **▶ Test voice** in the Voice feedback panel.

The server speaks only a fixed list of operational phrases (`server/src/voice/phrases.ts`): session start/stop/save,
signal detected/lost, clipping, hum, motion connected/lost, movement interference. It never speaks free text,
so the endpoint cannot be used to spend your quota, and it never produces medical advice. Each phrase is synthesised once
and then served from memory. Every announcement is also shown as text (🔊 spoken / 💬 text only).

## Bright Data: public-interest resources (US)

The dashboard's **Swallowing support resources (US)** panel lists public, attributed information from U.S. government
health sources: links to the publishers, never advice from DysphaGrip.

| Source | How it is collected | Why |
|---|---|---|
| NIH NIDCD: *Dysphagia*, *Swallowing Disorders*, *Nearly 1 in 12 children… swallowing* | **Bright Data Web Unlocker API** | Public domain; robots.txt allows it; no API exists |
| MedlinePlus: *Swallowing Disorders* (EN) and *Problemas para tragar* (ES) | MedlinePlus **official web service** | Public domain; an official API exists, so scraping would be wrong |

Rejected while vetting (see `server/src/resources/sources.ts`): ASHA (terms forbid scrapers), the Swallowing Disorder
Foundation (blocks automated requests), the Dysphagia Research Society (bot challenge; we never bypass one), and pages whose
official description gives intervention advice or that have no description to quote.

Setup:
1. In Bright Data's control panel create a **Web Unlocker API** zone; its *Overview* tab shows the API key and zone name.
2. Add `BRIGHTDATA_API_TOKEN=…` and `BRIGHTDATA_ZONE=…` to `.env`.
3. Run `npm run resources:refresh`. It collects every source (2 s between pages), stores them in Neon with source URL,
   publisher, language, collection method, licence note, source date and retrieval time, and reports any failures per
   source. It is a CLI script on purpose, so nobody can spend your Bright Data credits through the website.

## Neon (database)

1. **Easiest:** with the Neon CLI (`npm i -g neon`), run `neon login`, then in the repo root
   `neon init -y --agent claude-code --org-id <org> --project-id <project>`. It writes `DATABASE_URL`
   (pooled), `DATABASE_URL_UNPOOLED` and branch variables into `.env`, links the project (`.neon`,
   git-ignored) and creates `neon.ts`.
   **Manual alternative:** copy the **pooled** connection string from *Neon console → Connect* into
   `.env` as `DATABASE_URL=…`.
2. Never commit `.env`; it is git-ignored. The app reads only `DATABASE_URL`.
3. Create the tables, then run the live round-trip test:

   ```bash
   npm run db:migrate
   npm run test:db
   ```

4. Restart `npm run dev`. The **Neon** chip turns green and sessions save automatically when you stop them.

What is stored, per session: label, start/end time, duration, audio source name and kind, frame and
dropped-sample counts, activity and marker counts, median noise floor, max level, and time per signal-quality
state (`session_quality`). Each marker (`session_markers`) stores its kind, session time, duration, label and
optional short note. **No raw audio, names or health information are stored.** Sessions can be deleted from
the history panel (cascade-deletes their markers and quality rows).

| Table | Purpose |
|---|---|
| `recording_sessions` | One row per session (UUID id) with the summary metrics above |
| `session_markers` | Manual, audio-activity (experimental), quality and (later) movement-interference markers |
| `session_quality` | Time in each quality state: ok / no_signal / clipping / mains_hum |
| `public_resources` | Reserved for Bright Data (Phase 8) |

## Tests and checks

```bash
cd services/audio && python -m pytest -q    # 33 audio tests
npm test                                    # API (vitest + supertest), dashboard logic + API contract (vitest)
npm run test:db                             # live Neon round-trip (needs DATABASE_URL; skipped otherwise)
npm run typecheck                           # server + web strict TypeScript
npm run build                               # production build
```

## Environment variables

See [.env.example](.env.example). Secrets (`DATABASE_URL`, `ELEVENLABS_*`, `BRIGHTDATA_*`) are read by
the Express server only. Anything prefixed `VITE_` is shipped to the browser and must never hold a secret.

## API (Express, :3000)

- `GET /api/health`: health plus which integrations are configured
- `GET /api/db/status`: live Neon connectivity check with latency
- `GET /api/sessions?limit=50`: list sessions with summaries and quality breakdown
- `POST /api/sessions`: save `{label, motion_connected, summary, markers}`; validated, written in one transaction
- `GET /api/sessions/:id`: one session with its markers
- `DELETE /api/sessions/:id`: delete a session (and its markers and quality rows)
- Session routes return 503 when Neon is not configured, 400 with a reason for invalid input, and 502 with a redacted message on database errors
- `GET /api/voice`: voice configuration (configured, model, voice name) and the approved phrase list
- `POST /api/voice/status` `{message}`: speak one **approved** phrase via ElevenLabs and return MP3. 400 for any
  other text, 501 not configured, 429 local rate limit (30 uncached calls/min), 502/503/504 mapped ElevenLabs errors
- `GET /api/resources`: attributed public resources stored in Neon (collected offline by `npm run resources:refresh`; there is deliberately no HTTP endpoint that triggers collection)

The audio service API and WebSocket contract are documented in [services/audio/README.md](services/audio/README.md).

## Build progress

- [x] Phase 1: repository inspection, config fixes, test harness
- [x] Phase 2: Python audio service (UM2 detection, device selection, capture, waveform, spectrogram, features)
- [ ] Phase 3: MPU-6050 firmware + receiver
- [ ] Phase 4: shared session clock
- [x] Phase 5: React dashboard (audio side live; motion panels wait for Phase 3)
- [x] Phase 6: Neon (live: tables migrated, `npm run test:db` passing, dashboard sessions saved and read back)
- [x] Phase 7: ElevenLabs (live: cues spoken in a real session; allowlisted phrases, caching, rate limit)
- [x] Phase 8: Bright Data (live for MedlinePlus; NIDCD pages collect once `BRIGHTDATA_API_TOKEN` + `BRIGHTDATA_ZONE` are set)
- [ ] Phase 9: deployment

## Repository

GitHub: https://github.com/XxPosedd/dysphagrip (private).

To set up another machine (e.g. the MacBook used for audio capture):

```bash
git clone https://github.com/XxPosedd/dysphagrip.git
cd dysphagrip
```

Then follow *Run locally* above. `.env`, `.neon`, `node_modules/`, `.venv/` and recordings are git-ignored,
so create `.env` on each machine (copy `.env.example`, or run `neon init` to pull the Neon variables).

## Deploy

`render.yaml` and the `Dockerfile` build the web app and serve it from Express. The Python audio
service runs **locally** on the MacBook next to the hardware; it is not deployed. Deployment is
finalised in Phase 9.
