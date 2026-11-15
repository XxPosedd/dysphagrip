# Audio hardware: contact pickup → USB interface → MacBook

The acquisition layer is **device-agnostic**. Supported demos include:

- Cherub WCP-55 → M-Audio AIR 192|6
- KORG CM-300 → Behringer U-PHORIA UM2
- Equivalent contact pickup → Focusrite Scarlett 2i2

Select the USB input at runtime in the dashboard or via `python -m dysphagrip_audio devices`.

## Signal chain

```text
Contact pickup (e.g. Cherub WCP-55 / KORG CM-300)
        │  6.35 mm (1/4") instrument cable
        ▼
USB audio interface Hi-Z / INST input  (phantom power OFF)
        │  USB
        ▼
MacBook ──► services/audio (sounddevice)
```

### Example: KORG CM-300 → Behringer UM2

```text
KORG CM-300 contact pickup ──(1/4" mono cable)──► UM2 INPUT 2 (INST, Hi-Z)
                                                   UM2 ──(USB)──► MacBook ──► services/audio
```

## Wiring and settings

1. Connect the UM2 to the MacBook by USB. It is bus-powered, class-compliant and needs no driver.
2. Plug the CM-300 into **input 2** (the 1/4" instrument jack). A piezo contact pickup is a
   high-impedance source; the Hi-Z instrument input avoids loading it down.
   *Confirm the CM-300's plug type on your unit (see Open questions).*
3. **Turn the +48V phantom switch OFF.** The CM-300 is passive and does not need phantom power.
4. Start with the input-2 gain knob at about 12 o'clock. Tap the pickup lightly and raise gain
   until taps reach roughly −20 to −10 dBFS without the CLIP LED or `quality: clipping`.
5. Run `python -m dysphagrip_audio probe --device um2` and tap the pickup. The channel whose level
   jumps is the one to pass as `--channel`. It is expected to be `ch1` (input 2), but confirm it.
6. The UM2's direct-monitor headphone output does not affect what the computer records.

## macOS checks

* *System Settings → Sound → Input*: the UM2 should be listed (often as **"USB Audio CODEC"**).
* *Audio MIDI Setup*: confirm the format (e.g. 2 ch, 48 000 Hz). The service uses the device's
  default sample rate unless `--samplerate` is given.
* *Privacy & Security → Microphone*: allow Terminal or VS Code, otherwise you get silent buffers.

## Expected signal characteristics (for interpreting the dashboard)

* Piezo contact pickups are very sensitive to **handling noise**: cable movement and pickup
  sliding cause large low-frequency transients. These are real artefacts, not swallowing
  signals; the motion sensor (Phase 3) will help flag them.
* Unshielded or ungrounded setups pick up **50/60 Hz hum**. The `mains_hum` quality flag
  detects this. Try a different cable, or run the MacBook on battery.
* The CM-300 is designed as a tuner pickup. Its frequency response for body-conducted sound is
  not characterised, so treat the spectrum as relative, not calibrated.

## Safety

Follow [docs/SAFETY_AND_CLAIMS.md](../../docs/SAFETY_AND_CLAIMS.md). Use a non-compressive mount
(soft medical tape or a loose elastic band), never wrap anything tightly around the neck, use
consenting healthy volunteers only, and do not induce coughing or choking.
