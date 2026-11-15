# Early hardware prototypes (from the `test2` repo)

Original standalone scripts by maxhrdz (XxPosedd/test2, commit acae3ce), kept for reference. They are **not part of the
running app**; the app's equivalents live in `services/audio` and `apps/web`. Comments are in Spanish.

| Script | Purpose |
|---|---|
| `preba.py` | List audio devices |
| `live_microphone.py` | Live microphone waveform plot |
| `test_signal_quality.py` | Record 5 s from the contact mic to a WAV (recordings are git-ignored; never commit them) |
| `test_arduino_connection.py` | Check the Arduino serial connection |
| `sensor_fusion_live.py` | Live audio + motion plot |
| `event_detector_live.py` | Live event detector writing CSV logs |

Extra dependency: `pip install matplotlib` (plus the audio service's requirements). The original 5 s recording
(`dysphagrip_test.wav`) was intentionally not copied: raw audio is never committed to this repo.
