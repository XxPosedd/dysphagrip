"""Audio input device discovery and Behringer UM2 detection.

sounddevice (PortAudio) is imported lazily so DSP code and tests work on machines
without PortAudio.
"""
from __future__ import annotations

from typing import Any, Callable

# Names the UM2 may report. On macOS the UM2 commonly enumerates under its USB
# codec chip name ("USB Audio CODEC") rather than "UM2" -- that name is generic,
# so it is reported as a *possible* match only and must be confirmed by the user.
STRONG_PATTERNS = ("um2", "u-phoria", "uphoria", "behringer")
# Device-agnostic USB audio interfaces used with the contact pickup (M-Audio AIR,
# Focusrite, etc.). Strong match when the product name is explicit.
USB_AUDIO_STRONG = (
    "air 192", "m-audio", "m-audio air", "focusrite", "scarlett", "usb audio",
)
POSSIBLE_PATTERNS = ("usb audio codec",)


def _sd():
    import sounddevice as sd  # noqa: WPS433 (lazy import on purpose)
    return sd


def um2_match(name: str) -> str | None:
    lowered = name.lower()
    if any(p in lowered for p in STRONG_PATTERNS):
        return "strong"
    if any(p in lowered for p in POSSIBLE_PATTERNS):
        return "possible"
    return None


def usb_audio_match(name: str) -> str | None:
    """Hint for any supported USB audio interface (device-agnostic contact-mic path)."""
    lowered = name.lower()
    if um2_match(name) == "strong":
        return "strong"
    if any(p in lowered for p in USB_AUDIO_STRONG):
        return "strong"
    if um2_match(name) == "possible" or any(p in lowered for p in POSSIBLE_PATTERNS):
        return "possible"
    return None


def list_input_devices(query: Callable[[], Any] | None = None,
                       hostapis: Callable[[], Any] | None = None,
                       default_input: int | None = None) -> list[dict]:
    """Return input-capable devices with UM2 / USB-audio match hints. Arguments allow test injection."""
    if query is None:
        sd = _sd()
        query = sd.query_devices
        hostapis = sd.query_hostapis
        try:
            default_input = int(sd.default.device[0])
        except (TypeError, ValueError, IndexError):
            default_input = None
    apis = list(hostapis()) if hostapis else []
    out = []
    for index, dev in enumerate(query()):
        if int(dev.get("max_input_channels", 0)) <= 0:
            continue
        api_idx = dev.get("hostapi")
        api_name = apis[api_idx]["name"] if apis and api_idx is not None and api_idx < len(apis) else None
        out.append({
            "index": index,
            "name": dev["name"],
            "hostapi": api_name,
            "max_input_channels": int(dev["max_input_channels"]),
            "default_samplerate": float(dev["default_samplerate"]),
            "is_default": index == default_input,
            "um2_match": um2_match(dev["name"]),
            "usb_audio_match": usb_audio_match(dev["name"]),
        })
    return out


def find_um2(devices: list[dict]) -> dict | None:
    """Best UM2 candidate: strong name matches first; prefer 2-channel devices."""
    for level in ("strong", "possible"):
        candidates = [d for d in devices if d["um2_match"] == level]
        if candidates:
            candidates.sort(key=lambda d: (d["max_input_channels"] < 2, d["index"]))
            return candidates[0]
    return None


def find_usb_audio_interface(devices: list[dict]) -> dict | None:
    """Best USB audio interface for the contact pickup (M-Audio, Focusrite, UM2, …)."""
    for level in ("strong", "possible"):
        candidates = [d for d in devices if d.get("usb_audio_match") == level]
        if candidates:
            candidates.sort(key=lambda d: (d["max_input_channels"] < 2, d["index"]))
            return candidates[0]
    return None


class DeviceNotFound(LookupError):
    pass


def resolve_device(spec: int | str | None, devices: list[dict]) -> dict:
    """Resolve a device spec to a device dict.

    spec: None -> system default input; int or digit string -> device index;
          "um2" -> auto-detected UM2; other string -> case-insensitive name substring.
    """
    if not devices:
        raise DeviceNotFound("No audio input devices found.")
    if spec is None or spec == "" or spec == "default":
        for d in devices:
            if d["is_default"]:
                return d
        return devices[0]
    if isinstance(spec, int) or (isinstance(spec, str) and spec.isdigit()):
        idx = int(spec)
        for d in devices:
            if d["index"] == idx:
                return d
        raise DeviceNotFound(f"No input device with index {idx}.")
    if spec.lower() == "um2":
        found = find_um2(devices)
        if not found:
            names = ", ".join(d["name"] for d in devices)
            raise DeviceNotFound(f"Behringer UM2 not found. Available inputs: {names}")
        return found
    for d in devices:
        if spec.lower() in d["name"].lower():
            return d
    raise DeviceNotFound(f"No input device matching '{spec}'.")
