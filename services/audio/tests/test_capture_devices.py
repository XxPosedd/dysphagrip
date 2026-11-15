import numpy as np
import pytest
from scipy.io import wavfile

from dysphagrip_audio.capture import RingBuffer, WavFileSource, load_wav_mono
from dysphagrip_audio.config import AudioConfig
from dysphagrip_audio.devices import DeviceNotFound, find_um2, list_input_devices, resolve_device, um2_match
from dysphagrip_audio.processor import FrameProcessor

# ---- Ring buffer ---------------------------------------------------------


def test_ring_buffer_sequential_reads():
    rb = RingBuffer(10)
    rb.write(np.arange(4))
    data, start, dropped = rb.read_since(0)
    assert list(data) == [0, 1, 2, 3] and start == 0 and dropped == 0
    rb.write(np.arange(4, 9))
    data, start, _ = rb.read_since(4)
    assert list(data) == [4, 5, 6, 7, 8] and start == 4


def test_ring_buffer_wraparound_and_drop_reporting():
    rb = RingBuffer(5)
    rb.write(np.arange(8))
    data, start, dropped = rb.read_since(0)
    assert list(data) == [3, 4, 5, 6, 7] and start == 3 and dropped == 3
    assert rb.total_written == 8


def test_ring_buffer_oversized_write_keeps_newest():
    rb = RingBuffer(4)
    rb.write(np.arange(10))
    data, start, _ = rb.read_since(0)
    assert list(data) == [6, 7, 8, 9] and start == 6 and rb.total_written == 10


# ---- Device discovery (mocked PortAudio device lists) --------------------

MAC_DEVICES = [
    {"name": "MacBook Pro Microphone", "hostapi": 0, "max_input_channels": 1, "max_output_channels": 0, "default_samplerate": 48000.0},
    {"name": "MacBook Pro Speakers", "hostapi": 0, "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 48000.0},
    {"name": "USB Audio CODEC", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 0, "default_samplerate": 48000.0},
]
HOSTAPIS = [{"name": "Core Audio"}]


def test_um2_name_matching():
    assert um2_match("UM2") == "strong"
    assert um2_match("Behringer U-PHORIA UM2") == "strong"
    assert um2_match("USB Audio CODEC") == "possible"
    assert um2_match("MacBook Pro Microphone") is None


def test_list_input_devices_filters_outputs_and_flags_um2():
    devs = list_input_devices(lambda: MAC_DEVICES, lambda: HOSTAPIS, default_input=0)
    assert [d["index"] for d in devs] == [0, 2]
    assert devs[0]["is_default"] and devs[0]["hostapi"] == "Core Audio"
    assert devs[1]["um2_match"] == "possible"


def test_find_um2_prefers_strong_match():
    devs = list_input_devices(lambda: MAC_DEVICES + [
        {"name": "UM2", "hostapi": 0, "max_input_channels": 2, "default_samplerate": 48000.0}],
        lambda: HOSTAPIS)
    assert find_um2(devs)["name"] == "UM2"


def test_resolve_device_variants():
    devs = list_input_devices(lambda: MAC_DEVICES, lambda: HOSTAPIS, default_input=0)
    assert resolve_device(None, devs)["index"] == 0
    assert resolve_device(2, devs)["index"] == 2
    assert resolve_device("2", devs)["index"] == 2
    assert resolve_device("um2", devs)["name"] == "USB Audio CODEC"
    assert resolve_device("macbook", devs)["index"] == 0
    with pytest.raises(DeviceNotFound):
        resolve_device(9, devs)
    with pytest.raises(DeviceNotFound):
        resolve_device("um2", devs[:1])


def test_device_source_rejects_bad_channel():
    from dysphagrip_audio.capture import DeviceSource
    dev = {"index": 0, "name": "Mic", "max_input_channels": 1, "default_samplerate": 48000.0}
    with pytest.raises(ValueError):
        DeviceSource(dev, channel=1)


# ---- WAV playback + frame processing --------------------------------------


def _write_wav(path, fs=16000, seconds=1.0, freq=440.0, channels=1):
    t = np.arange(int(fs * seconds)) / fs
    x = (0.5 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)
    if channels == 2:
        x = np.stack([np.zeros_like(x), x], axis=1)
    wavfile.write(path, fs, x)


def test_load_wav_mono_selects_channel(tmp_path):
    p = tmp_path / "s.wav"
    _write_wav(p, channels=2)
    fs, x = load_wav_mono(p, channel=1)
    assert fs == 16000 and x.ndim == 1 and np.abs(x).max() == pytest.approx(0.5, abs=0.01)
    _, silent = load_wav_mono(p, channel=0)
    assert np.abs(silent).max() == 0
    with pytest.raises(ValueError):
        load_wav_mono(p, channel=2)


def test_frame_processor_on_buffered_samples(tmp_path):
    p = tmp_path / "s.wav"
    _write_wav(p, fs=16000, freq=1000.0)
    src = WavFileSource(p)
    src.anchor_unix_ns = 1_700_000_000_000_000_000
    src.buffer.write(src.data[:1600])            # feed 100 ms without the playback thread
    proc = FrameProcessor(src, AudioConfig())
    frame = proc.process()
    assert frame["source"] == "file"
    assert frame["n_samples"] == 1600 and frame["sample_index"] == 0
    assert frame["t_end_unix_ms"] - frame["t_start_unix_ms"] == pytest.approx(100.0)
    assert len(frame["spectrum"]["db"]) == 128
    assert abs(frame["features"]["dominant_hz"] - 1000) < 16000 / 2048 * 1.5
    assert frame["quality"]["label"] == "ok"
    assert proc.process() is None                 # nothing new
    src.buffer.write(src.data[1600:2400])
    nxt = proc.process()
    assert nxt["sample_index"] == 1600 and nxt["seq"] == 2


def test_wav_source_plays_in_real_time(tmp_path):
    import time
    p = tmp_path / "s.wav"
    _write_wav(p, fs=16000, seconds=0.2)
    src = WavFileSource(p, loop=True)
    src.start()
    time.sleep(0.3)
    src.stop()
    n = src.buffer.total_written
    assert 16000 * 0.2 < n < 16000 * 0.6         # ~0.3 s worth, looped past file end
    assert src.info()["kind"] == "file" and src.anchor_method == "file_playback_start"
