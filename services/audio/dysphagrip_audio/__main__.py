"""Command line entry point.

  python -m dysphagrip_audio devices                  list inputs, highlight UM2
  python -m dysphagrip_audio probe --device um2       live per-channel levels (find the right UM2 input)
  python -m dysphagrip_audio serve [--device um2 --channel 1 --autostart] [--wav file.wav]
"""
from __future__ import annotations

import argparse
import logging
import sys
import time


def cmd_devices(_args) -> int:
    from .devices import find_um2, list_input_devices
    devs = list_input_devices()
    if not devs:
        print("No audio input devices found.")
        return 1
    um2 = find_um2(devs)
    print(f"{'idx':>4}  {'ch':>2}  {'rate':>7}  {'host API':<22} name")
    for d in devs:
        tag = ""
        if um2 and d["index"] == um2["index"]:
            tag = "  <-- UM2" + (" (possible: confirm name)" if d["um2_match"] == "possible" else "")
        elif d["um2_match"]:
            tag = f"  ({d['um2_match']} UM2 match)"
        default = "*" if d["is_default"] else " "
        print(f"{d['index']:>4}{default} {d['max_input_channels']:>2}  {d['default_samplerate']:>7.0f}  "
              f"{(d['hostapi'] or ''):<22} {d['name']}{tag}")
    print("\n* = system default input")
    if not um2:
        print("Behringer UM2 not detected. Check the USB connection and that macOS lists it in Audio MIDI Setup.")
    return 0


def cmd_probe(args) -> int:
    """Show live RMS per channel so the user can tap the contact mic and see which input it is on."""
    import numpy as np
    import sounddevice as sd
    from .devices import list_input_devices, resolve_device
    from .dsp import to_dbfs, rms

    dev = resolve_device(args.device, list_input_devices())
    channels = dev["max_input_channels"]
    fs = dev["default_samplerate"]
    levels = np.full(channels, -120.0)

    def cb(indata, frames, time_info, status):
        for c in range(channels):
            levels[c] = to_dbfs(rms(indata[:, c].astype(np.float64)))

    print(f"Probing '{dev['name']}' ({channels} ch @ {fs:.0f} Hz) for {args.seconds}s. "
          "Tap the contact mic now. Ctrl+C to stop.")
    try:
        with sd.InputStream(device=dev["index"], channels=channels, samplerate=fs, callback=cb):
            end = time.time() + args.seconds
            while time.time() < end:
                parts = []
                for c in range(channels):
                    bar = "#" * int(max(0, min(40, (levels[c] + 100) / 2.5)))
                    parts.append(f"ch{c} {levels[c]:6.1f} dBFS |{bar:<40}|")
                sys.stdout.write("\r" + "   ".join(parts))
                sys.stdout.flush()
                time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    print()
    return 0


def cmd_serve(args) -> int:
    import uvicorn
    from .config import AudioConfig
    from .server import StartRequest, create_app, default_source_factory

    autostart = None
    if args.autostart or args.wav:
        device = int(args.device) if args.device and args.device.isdigit() else args.device
        autostart = StartRequest(device=device, channel=args.channel, samplerate=args.samplerate)
    cfg = AudioConfig(silence_dbfs=args.silence_dbfs)
    app = create_app(cfg, default_source_factory(args.wav), autostart=autostart)
    if args.wav:
        print(f"FILE PLAYBACK MODE: streaming '{args.wav}' (frames are labelled source='file', not live).")
    print(f"Viewer: http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def main(argv: list[str] | None = None) -> int:
    from .config import AudioConfig
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="dysphagrip_audio", description="DysphaGrip audio service")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices", help="list audio inputs").set_defaults(fn=cmd_devices)

    pr = sub.add_parser("probe", help="live per-channel input levels")
    pr.add_argument("--device", default="um2", help="index, name substring, 'um2' or 'default'")
    pr.add_argument("--seconds", type=float, default=20.0)
    pr.set_defaults(fn=cmd_probe)

    sv = sub.add_parser("serve", help="run the HTTP/WebSocket service")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--device", default=None, help="index, name substring, 'um2' or omit for default")
    sv.add_argument("--channel", type=int, default=0, help="0-based input channel")
    sv.add_argument("--samplerate", type=float, default=None)
    sv.add_argument("--autostart", action="store_true", help="start capturing immediately")
    sv.add_argument("--silence-dbfs", type=float, default=AudioConfig.silence_dbfs,
                    help="RMS level below which quality is 'no_signal' (calibrate per microphone)")
    sv.add_argument("--wav", default=None, help="replay a WAV file instead of a device (labelled 'file')")
    sv.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
