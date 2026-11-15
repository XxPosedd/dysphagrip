# Open questions

Resolved: sponsor tracks are exactly Best Overall Hack, Bright Data (Data for Good), ElevenLabs
and Neon. No MLH tracks.

## Audio (needed to finish Phase 2 validation on real hardware)

1. What name does the UM2 show in `python -m dysphagrip_audio devices` on the MacBook (e.g. "UM2"
   or "USB Audio CODEC")?
2. Which channel does the CM-300 appear on when plugged into UM2 input 2? Run
   `python -m dysphagrip_audio probe --device um2` and tap the pickup.
3. What plug does your CM-300 cable end in (1/4" / 6.3 mm, or 3.5 mm)? This decides the UM2 input or adapter.
4. Which macOS version and Python version are on the MacBook?
4b. Calibration, once the hardware is here: the RMS level of the UM2 + CM-300 when attached and still.
   The `no_signal` threshold defaults to −70 dBFS and may need lowering with `--silence-dbfs`
   (a quiet room on a laptop mic already sits around −80 dBFS).

## Motion (needed before Phase 3)

5. Exact MPU-6050 breakout (marking/vendor), and does it have an on-board regulator? (Is VCC 3.3 V or 5 V tolerant?)
6. Are header pins soldered?
7. Transport preference: USB serial from the UNO Q's MCU (simplest) or the UNO Q's Linux side over Wi-Fi?

## Later phases

8. Which public-interest source(s) should Bright Data retrieve, and are automated requests permitted by their terms?
9. Hosting provider for the web app/API (Render is scaffolded).
