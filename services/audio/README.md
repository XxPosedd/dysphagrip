# DysphaGrip audio service (Python)

Captures one channel from an audio input (target: **KORG CM-300 → Behringer UM2 → MacBook**),
computes signal features and streams them over WebSocket to the dashboard.

> Experimental engineering prototype. Features describe the *audio signal* (level, spectrum,
> hum, clipping, activity above the noise floor). They are not clinical measurements and do
> not detect aspiration, residue, or confirm safe swallowing.

## Setup (macOS; Windows/Linux work the same)

```bash
cd services/audio
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

**macOS microphone permission:** the first capture triggers a permission prompt for the app
running Python (Terminal, iTerm or VS Code). If you dismissed it, enable it in
*System Settings → Privacy & Security → Microphone*. Without permission macOS delivers
**silent buffers**, which the service reports as quality `no_signal`.

## Commands

```bash
python -m dysphagrip_audio devices                     # list inputs; UM2 is marked
python -m dysphagrip_audio probe --device um2          # live level per channel: tap the mic to find its channel
python -m dysphagrip_audio serve                       # start service on http://127.0.0.1:8765 (choose device in viewer)
python -m dysphagrip_audio serve --device um2 --channel 1 --autostart
python -m dysphagrip_audio serve --wav recording.wav   # FILE PLAYBACK: frames labelled source="file", never "device"
python -m dysphagrip_audio serve --silence-dbfs -85     # tune the no_signal threshold for your microphone
```

Open **http://127.0.0.1:8765/** for the standalone diagnostic viewer (waveform, spectrogram,
features, quality). The React dashboard (Phase 5) consumes the same WebSocket.

`--device` accepts a device index, a name substring, `um2` (auto-detect) or nothing (system default).
`--channel` is 0-based: on the UM2, `0` = input 1 (XLR/TRS combo), `1` = input 2 (instrument, Hi-Z).
Confirm the mapping on your unit with `probe`.

### UM2 detection

Devices whose name contains `UM2`, `U-PHORIA` or `Behringer` are a **strong** match. On macOS the
UM2 often enumerates as **`USB Audio CODEC`** (its USB chip). That name is generic, so it is shown
as a **possible** match. Confirm by unplugging the UM2 and checking that the entry disappears.

## API

| Method | Path | Body / response |
|---|---|---|
| GET | `/health` | `{ok, service, running}` |
| GET | `/devices` | `{devices: [{index, name, hostapi, max_input_channels, default_samplerate, is_default, um2_match}], um2_candidate}` |
| GET | `/status` | running state, source info, dropped samples, config, last error |
| POST | `/start` | `{device?: int\|string, channel?: int, samplerate?: number}` → status. 404 unknown device, 400 bad channel, 500 PortAudio error. A rejected start leaves any current capture running. |
| POST | `/stop` | status |
| WS | `/stream` | messages below |

WebSocket messages (JSON):

```jsonc
{"type": "hello",  ...status}          // on connect
{"type": "status", ...status}          // after start/stop
{"type": "error",  "message": "..."}   // device unplugged, no samples for 2 s, ...
{"type": "audio_frame",                // ~every 50 ms
 "seq": 12, "source": "device" | "file", "fs": 48000,
 "sample_index": 115200, "n_samples": 2400,
 "t_start_unix_ms": 1794699258875.949, "t_end_unix_ms": 1794699258925.949,
 "dropped_samples": 0,
 "waveform": {"min": [...200], "max": [...200]},        // 20 Hz high-passed envelope
 "spectrum": {"fmax_hz": 4000, "db": [...128]},         // one spectrogram column, dBFS, low→high
 "features": {"rms_dbfs", "peak", "clip_fraction", "zcr", "spectral_centroid_hz", "dominant_hz",
              "band_fraction": {"low": "20-250 Hz", "mid": "250-1000 Hz", "high": "1-4 kHz"},
              "hum_ratio", "noise_floor_dbfs", "snr_db", "activity"},
 "quality": {"label": "ok" | "no_signal" | "clipping" | "mains_hum", "reasons": ["..."]}}
```

The WebSocket accepts only origins in `DEFAULT_ORIGINS` (localhost dashboard/API/viewer), so
an arbitrary website cannot read the audio stream.

## Signal features

| Feature | Meaning |
|---|---|
| `rms_dbfs` | RMS level of the new samples after a 20 Hz high-pass (removes DC/rumble) |
| `peak`, `clip_fraction` | Raw (pre-filter) peak and fraction of samples ≥ 0.98 FS |
| `noise_floor_dbfs` | Adaptive floor: falls quickly to quiet levels, rises at most 1.5 dB/s |
| `snr_db`, `activity` | Level above the floor; `activity` = ≥ 10 dB above the floor. A generic audio-activity flag, **not** a swallow detector |
| `dominant_hz`, `spectral_centroid_hz`, `band_fraction` | From a 2048-point Hann FFT of the most recent samples |
| `hum_ratio` | Fraction of 20–1000 Hz power at 50/60 Hz and harmonics (Welch, 0.5 s). High on badly grounded Hi-Z contact pickups |

Thresholds live in `dysphagrip_audio/config.py`. They are engineering starting points, not
validated values.

## Timestamps (input to Phase 4 synchronisation)

* Every sample has an absolute index. Frame time = `anchor + sample_index / fs`, so audio
  timestamps follow the audio sample clock with no per-block jitter.
* The **anchor** (Unix time of sample 0) is taken at the first callback:
  * `portaudio_adc_time`: callback arrival minus PortAudio's reported ADC latency (macOS Core Audio usually provides this).
  * `callback_arrival_minus_block`: fallback when the host API reports no ADC time (e.g. Windows MME). Error ≈ one block plus driver latency (typically < 20 ms).
* The audio crystal and the system clock drift apart (typically 10–100 ppm, i.e. up to ~6 ms per
  minute). `/status → source.wall_minus_sample_clock_ms` exposes the current offset. Phase 4
  will use it to re-anchor.
* `dropped_samples` counts samples overwritten before processing (10 s ring buffer), and
  `overflows` counts PortAudio input overflows. Both should stay at 0.

## Tests

```bash
cd services/audio && python -m pytest -q
```

33 tests cover the DSP against synthetic signals (tone frequency and level, hum, clipping, filter
continuity, noise floor), the ring buffer, UM2 detection against mocked macOS device lists,
WAV playback, frame processing, and the REST/WebSocket server. The tests inject a *test-only*
tone source into `create_app()`. It is not reachable from the CLI.
