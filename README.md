# DysphaGrip: Multimodal Swallowing Signal Monitoring

Real-time research prototype for **SanD Hacks 2026**. Captures **contact-microphone audio**
(Cherub WCP-55 / KORG CM-300 → USB audio interface) and **neck-adjacent motion**
(Arduino UNO Q + MPU-6050), fuses both streams, and visualises experimental candidate events.

> **Safety and claims:** This is an experimental engineering prototype, **not a medical device**.
> It does not diagnose dysphagia and does not detect aspiration, silent aspiration or pharyngeal
> residue. It cannot confirm that swallowing is safe. It must not be used for feeding,
> treatment or emergency decisions. See [docs/SAFETY_AND_CLAIMS.md](docs/SAFETY_AND_CLAIMS.md).

## V2 highlights (`feature/dysphagrip-v2-live-dashboard`)

- Premium dark MedTech dashboard: Overview · Live · Sessions · Device Setup · Research Limits
- **Live Mode** (real USB audio + IMU) and labelled **Demo Mode** (`SIMULATED DEMO DATA` banner)
- Multimodal WebSocket (`/ws/live`): acoustic frames, IMU, fusion events, device health
- Explainable heuristic event detector (swallow candidate / motion artifact / unclassified)
- Baseline calibration, local SQLite session archive + JSON/CSV export
- UNO Q MPU-6050 firmware + Linux TCP streamer (honest connection reporting)

## Architecture

```text
Contact pickup → USB audio interface ─USB─► services/audio (Python FastAPI)
                                              │  REST + /stream + /ws/live
MPU-6050 → UNO Q (I²C) → TCP/serial ─────────┘
                                              ▼
apps/web (React + Vite + TS) ◄──► server (Express + Neon / ElevenLabs / Bright Data)
```

## Hardware

| Path | Components |
|---|---|
| Acoustic | Cherub WCP-55 (or similar contact pickup) → M-Audio AIR 192\|6 / Focusrite / Behringer UM2 → MacBook |
| Biomechanical | MPU-6050 → Arduino UNO Q (I²C) → Linux TCP streamer → MacBook |
| Host | MacBook Apple Silicon (backend + dashboard) |

**Acoustic wiring notes:** phantom power **OFF**; pickup goes to the USB interface instrument input — **not** an Arduino analog pin. See [hardware/audio_um2_cm300/README.md](hardware/audio_um2_cm300/README.md).

**IMU wiring (verify breakout voltage first):** VCC→3.3V, GND→GND, SDA→D20, SCL→D21. Firmware and streamer: [hardware/unoq_mpu6050/README.md](hardware/unoq_mpu6050/README.md).

## Repository structure

```text
apps/web/                 React dashboard (Vite, TypeScript)
server/                   Express API: Neon sessions, voice, resources
services/audio/           Python multimodal signal service
  dysphagrip_audio/       capture, dsp, imu, fusion, demo, calibration, sessions, monitor
hardware/
  audio_um2_cm300/        USB audio + contact pickup notes
  unoq_mpu6050/           firmware + linux_streamer.py
docs/                     decisions, safety, demo script
```

## Install (macOS Apple Silicon)

Requirements: Node.js 20+, Python 3.10+ (3.13 recommended if 3.14 wheels/tools misbehave), Git.

```bash
npm install
npm run install:all

cd services/audio
python3.13 -m venv .venv          # or python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..

cp .env.example .env              # optional integrations
```

## Run

### Demo Mode (no hardware)

```bash
# Terminal 1 — signal service
cd services/audio && source .venv/bin/activate
python -m dysphagrip_audio serve

# Terminal 2 — Express API + web
npm run dev
```

Open http://localhost:5173 → sidebar **Demo** → **Live Monitoring** → **Start Monitoring**.
The orange banner **SIMULATED DEMO DATA** must be visible.

### Live Mode

1. Connect USB audio interface; allow mic permission for your terminal.
2. Flash `hardware/unoq_mpu6050/firmware/dysphagrip_imu/` onto the UNO Q.
3. On the UNO Q Linux side: `python3 hardware/unoq_mpu6050/linux_streamer.py --port 9001`
4. Start the signal service and `npm run dev` as above.
5. Dashboard → **Device Setup**: select audio device; connect IMU via TCP (or serial if exposed).
6. **Live Monitoring** → Start input → Start Monitoring → Calibrate Baseline (optional).

### Useful CLI

```bash
cd services/audio && source .venv/bin/activate
python -m dysphagrip_audio devices
python -m dysphagrip_audio probe --device um2   # or a name substring for M-Audio / Focusrite
```

## API (signal service :8765)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Mode, monitoring, audio/IMU health |
| `GET /api/devices` | Audio inputs + serial ports + IMU status |
| `POST /api/mode` | `{ "mode": "live" \| "demo" }` |
| `POST /api/sessions/start\|stop\|reset` | Session lifecycle |
| `POST /api/calibration` | Baseline calibration |
| `GET /api/sessions[/{id}/export]` | List / inspect / export |
| `WS /ws/live` | Multimodal live frames |
| `GET/POST /devices|/start|/stop` + `WS /stream` | Original audio-only contract (preserved) |

Proxied in Vite as `/audio/*`. Express remains on `/api/*` for Neon, ElevenLabs, Bright Data.

## Tests

```bash
# Python
cd services/audio && source .venv/bin/activate && pytest -q

# Frontend + Express
npm test
npm run typecheck
npm run build
```

## Sponsor integrations (unchanged)

| Track | Status |
|---|---|
| Bright Data public resources | ✅ |
| ElevenLabs operational voice cues | ✅ |
| Neon session persistence (Express) | ✅ |
| Live audio + motion fusion dashboard | ✅ V2 |

Optional env vars: see [.env.example](.env.example). Never commit `.env` or raw recordings.

## Known limitations

- Heuristic fusion is **not** a validated clinical classifier.
- UNO Q serial may not appear as macOS `/dev/cu.*`; prefer the Linux TCP streamer.
- Physical IMU/audio paths require connected hardware to validate end-to-end; Demo Mode covers UI/demo without sensors.
- Local SQLite sessions in `services/audio/data/` are separate from Neon Postgres saves in the Express API.

## Medical research disclaimer

DysphaGrip is a hackathon / research sensing prototype. Outputs are experimental indicators only.
Do not use for diagnosis, treatment, feeding decisions, or emergency care.
