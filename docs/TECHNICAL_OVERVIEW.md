# DysphaGrip: technical overview (for presenting and judge Q&A)

DysphaGrip is an **experimental** real-time monitor: a contact microphone and a motion sensor at the neck,
a local signal-processing service, a web dashboard, and cloud services for storage, voice and public
resources. It shows signals and signal quality; it does **not** diagnose or detect aspiration.

---

## 1. How the hardware connects to the code

### Audio path (KORG CM-300 → Behringer UM2 → MacBook)
1. The **CM-300** is a passive piezo contact pickup. It turns surface vibration into a tiny electrical signal.
2. It plugs into the **UM2's Hi-Z instrument input** (input 2). The UM2 is a USB audio interface: it
   amplifies the signal and **digitises** it (analog-to-digital converter, 44.1/48 kHz).
3. Over **USB**, macOS sees the UM2 as a normal audio input device (often named "USB Audio CODEC").
4. Our **Python audio service** opens that device with **sounddevice** (a wrapper around the PortAudio
   C library). PortAudio calls our code with a block of samples every few milliseconds.

So: vibration → voltage → digital samples → Python, with no custom driver.

### Motion path (MPU-6050 → Arduino UNO Q → MacBook)
1. The **MPU-6050** is a 6-axis IMU: a 3-axis accelerometer (g) and a 3-axis gyroscope (°/s) on one chip.
2. It talks to the **Arduino UNO Q** over **I2C** (two wires: SDA data, SCL clock, plus power and ground).
3. Our **firmware** (`hardware/unoq_mpu6050/dysphagrip_mpu6050/dysphagrip_mpu6050.ino`) wakes the sensor,
   configures ±2 g / ±250 °/s and a ~44 Hz low-pass filter, and reads all 14 data bytes **100 times a second**.
4. It converts raw numbers to physical units (accel ÷ 16384 = g, gyro ÷ 131 = °/s) and prints one line of
   **JSON per sample**: `{"type":"imu","seq":42,"t_ms":12345,"ax":0.01,…,"gz":0.05}`.
5. That text stream reaches the MacBook over **USB serial**, or, if the UNO Q routes the microcontroller to its
   on-board Linux side, through our small **relay** (`hardware/unoq_mpu6050/relay/serial_to_tcp.py`)
   over the network (TCP). The Mac's receiver accepts either.
6. The **same Python service** reads those lines with **pyserial** (or a TCP socket).

---

## 2. How the code works: the pipeline

```
CM-300 → UM2 ──USB audio──┐
                          ├─► Python service (FastAPI, port 8765) ──WebSocket──► React dashboard (port 5173)
MPU-6050 → UNO Q ─USB/TCP─┘     signal processing + shared clock                    │ HTTP
                                                                                      ▼
                                                   Node/Express API (port 3000) ──► Neon (Postgres)
                                                                                └──► ElevenLabs (voice)
                         Bright Data + MedlinePlus ──(npm run resources:refresh)──► Neon
```

### a) Python service: `services/audio/dysphagrip_audio/`
- **capture.py**: opens the input, writes samples into a **ring buffer** (a fixed-size circular array),
  and gives every sample an absolute index. It also records the **anchor**, the wall-clock time of sample 0.
- **dsp.py**: the signal processing, using NumPy and SciPy:
  - **High-pass filter** at 20 Hz (Butterworth): removes DC offset and rumble.
  - **RMS level** in dBFS: loudness.
  - **FFT spectrum**: a Hann window plus a fast Fourier transform, giving which frequencies are present.
    Pooled into 128 bands from 0–4 kHz, this is one column of the spectrogram.
  - **Spectral centroid, dominant frequency, band energy**: summaries of that spectrum.
  - **Mains hum detection**: share of power at 50/60 Hz and their harmonics (Welch method), the classic
    problem with contact mics on bad cables.
  - **Clipping**: fraction of samples at full scale (input too loud).
  - **Adaptive noise floor**: tracks background level (falls fast, rises slowly). "Activity" means ≥ 10 dB
    above it. That is a generic energy flag, **not** a swallow detector.
  - **Quality rules**: no_signal / clipping / mains_hum / ok, each with a human-readable reason.
- **processor.py**: every 50 ms takes the new samples and builds one **frame**: a 200-point waveform
  envelope, a 128-bin spectrogram column, the features, the quality and timestamps.
- **motion.py** *(in progress)*: parses the IMU lines, maps board time to Mac time (**ClockSync**), and
  runs the **movement-interference detector**.
- **server.py**: FastAPI app. REST endpoints to list devices and start/stop capture, and a **WebSocket**
  (`/stream`) that pushes ~20 frames per second to the dashboard. Only localhost pages may connect.

### b) React dashboard: `apps/web`
- Connects to the WebSocket and **draws on HTML canvas**: waveform, scrolling spectrogram and session
  timeline. Canvas is used instead of chart libraries because 20 updates per second need to be cheap.
- **SessionRecorder** (pure TypeScript): during a session it stores a timeline point per frame, turns
  "activity" into segments (≥ 150 ms on, gaps under 200 ms bridged), debounces quality changes (must
  persist 1 s) and computes the summary.
- **Voice cues**: when quality changes or a session starts or stops, it asks the API to speak a fixed phrase.
- On **Stop**, it sends the session summary and markers to the API.

### c) Node API: `server`
- **Express + TypeScript**. It holds every secret, so the browser never sees a key.
- **Neon**: validates the session (types, lengths, times, allowed marker kinds), then writes the session,
  its markers and its quality summary in **one transaction**.
- **ElevenLabs**: speaks only an **allowlist** of non-clinical phrases; caches audio; rate-limited.
- **Resources**: reads the stored public resources.
- **`npm run resources:refresh`** (CLI only): fetches vetted pages via **Bright Data Web Unlocker** and
  MedlinePlus via its official API, keeps only title, description, link and dates, and upserts into Neon.

---

## 3. Synchronisation (how audio and motion line up)
- Both streams are timestamped **by the same process, on the MacBook's clock**.
- **Audio**: time of sample *n* = anchor + n ÷ sample rate. That follows the audio crystal, so there is no
  per-block jitter. The difference between the audio clock and the system clock is reported as
  `wall_minus_sample_clock_ms`.
- **Motion**: the board stamps each sample with its own `millis()`. On the Mac we record each line's
  arrival time and keep the **minimum** of (arrival − board time) over 30 s. The fastest-arriving
  sample is the least delayed, so that minimum is the best estimate of the clock offset. Board time
  + offset gives Mac time.
- **Accuracy (honest numbers)**:
  - Motion: error ≈ the minimum USB latency (a few ms over USB, more over Wi-Fi). Jitter and drift are
    measured and shown.
  - Audio: anchor error is about one audio block (~5–20 ms, depending on the OS audio API).
  - Combined: tens of ms, which is fine for "did the sensor move while this sound happened"; it is not
    sample-accurate.

---

## 4. Data and privacy
- **Raw audio never leaves the laptop.** The browser receives envelopes, spectrogram columns and numbers.
- **Neon stores**: session summaries, markers and quality time, and resource metadata. No names, no audio.
- **Bright Data pages**: only the title, the publisher's own description and the link are kept.
- **Secrets**: only in `.env` on the machine; never in git (checked before every commit).

---

## 5. Testing
- **114 automated tests**:
  - **Python (pytest)**: DSP checked against synthetic tones, noise and hum; ring buffer; device
    detection; the server and WebSocket.
  - **API (Vitest + Supertest)**: every route, validation rules, error paths, the ElevenLabs client
    against a simulated API, and Bright Data parsing on saved real pages.
  - **Dashboard (Vitest)**: session logic, plus a contract test proving that what the dashboard sends
    passes the server's validator.
  - **Live**: one Neon round-trip test against the real database.

---

## 6. Likely judge questions, with short answers

**Does it detect aspiration or diagnose dysphagia?**
No. It is an experimental engineering prototype. It shows signals, flags poor recordings and lets users
mark events. Detecting aspiration needs clinical ground truth (VFSS/FEES), ethics approval and validation.

**How do you know a recording is good?**
Rule-based quality checks run every 50 ms: level below −70 dBFS means no signal, samples at full scale
mean clipping, energy concentrated at 50/60 Hz means mains hum. The motion sensor adds movement interference.

**Why a contact mic instead of a normal mic?**
It picks up vibration through the skin and rejects room noise. It is also very sensitive to handling,
which is why we built signal-quality checks and the motion sensor.

**Why is the motion sensor there?**
Neck and head movement and cable handling create artefacts in the audio. The IMU tells us *when* the
mount moved, so those moments can be flagged as unreliable.

**Why Python and Node?**
Python has the best scientific audio stack (NumPy/SciPy/PortAudio). Node/Express keeps the web API and
secrets separate and is simple to deploy. The two talk only through the dashboard.

**Why WebSocket?**
The server pushes about 20 updates a second; polling with HTTP would be slower and wasteful.

**How accurate is the timing?**
See section 3: same-host clock, minimum-latency offset estimation, typically tens of ms combined.

**What does Bright Data do?**
It collects public, attributed swallowing resources from non-profit sites that have no API. We vetted 19
sources and kept 3; Bright Data blocks government sites, so government content comes from the MedlinePlus API.

**What does ElevenLabs do?**
It speaks status cues (start, stop, saved, no signal, clipping, hum, movement). Phrases come from a fixed,
non-medical list, so the endpoint can't be abused or give advice.

**What does Neon do?**
It stores sessions, markers and quality summaries (one transaction per save) and the public resources.

**Could this use ML?**
Yes, as future work: start with a movement and bad-recording classifier trained on labelled volunteer
sessions and evaluated on unseen people. Clinical detection would need clinical partners.

**What would you do next?**
Calibrate on the real hardware, collect labelled volunteer data, train the artefact classifier, and work
with speech-language pathologists on what a clinically useful signal would be.
