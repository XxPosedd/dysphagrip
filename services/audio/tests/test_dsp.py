import numpy as np
import pytest

from dysphagrip_audio import dsp

FS = 48000.0


def tone(freq, seconds=0.5, amp=0.5, fs=FS):
    t = np.arange(int(fs * seconds)) / fs
    return amp * np.sin(2 * np.pi * freq * t)


def test_rms_and_dbfs_of_full_scale_sine():
    x = tone(1000, amp=1.0)
    assert dsp.rms(x) == pytest.approx(1 / np.sqrt(2), rel=1e-3)
    assert dsp.to_dbfs(dsp.rms(x)) == pytest.approx(-3.01, abs=0.05)


def test_silence_is_very_low_db():
    assert dsp.to_dbfs(dsp.rms(np.zeros(1000))) < -200


def test_spectrum_peak_at_tone_frequency_and_amplitude():
    x = tone(440, seconds=2048 / FS, amp=1.0)
    freqs, db = dsp.spectrum_db(x, FS, 2048)
    assert abs(freqs[np.argmax(db)] - 440) < FS / 2048
    assert db.max() == pytest.approx(0.0, abs=1.5)   # full-scale sine ~0 dBFS (scalloping < 1.5 dB)


def test_pool_spectrum_shape_and_peak_location():
    x = tone(1000, seconds=2048 / FS)
    freqs, db = dsp.spectrum_db(x, FS, 2048)
    col = dsp.pool_spectrum(freqs, db, 4000, 128)
    assert col.shape == (128,)
    assert abs(np.argmax(col) - 1000 / 4000 * 128) <= 2


def test_pool_spectrum_interpolates_when_few_bins():
    freqs, db = dsp.spectrum_db(tone(100, seconds=0.01), FS, 256)
    assert dsp.pool_spectrum(freqs, db, 4000, 128).shape == (128,)


def test_zero_crossing_rate_of_tone():
    x = tone(1000, seconds=1.0)
    assert dsp.zero_crossing_rate(x) == pytest.approx(2 * 1000 / FS, rel=0.02)


def test_spectral_centroid_of_tone():
    freqs, db = dsp.spectrum_db(tone(2000, seconds=2048 / FS), FS, 2048)
    assert dsp.spectral_centroid(freqs, 10 ** (db / 10)) == pytest.approx(2000, rel=0.05)


def test_band_fractions_sum_to_one_and_pick_band():
    freqs, db = dsp.spectrum_db(tone(500, seconds=2048 / FS), FS, 2048)
    bands = dsp.band_fractions(freqs, 10 ** (db / 10))
    assert sum(bands.values()) == pytest.approx(1.0, abs=1e-6)
    assert bands["mid"] > 0.95


def test_clip_fraction():
    x = np.concatenate([np.full(10, 1.0), np.zeros(990)])
    assert dsp.clip_fraction(x, 0.98) == pytest.approx(0.01)


@pytest.mark.parametrize("mains", [50.0, 60.0])
def test_mains_hum_detected(mains):
    assert dsp.mains_hum_ratio(tone(mains), FS) > 0.9


def test_broadband_noise_is_not_hum():
    rng = np.random.default_rng(0)
    assert dsp.mains_hum_ratio(rng.normal(0, 0.1, int(FS / 2)), FS) < 0.1


def test_envelope_bounds():
    x = tone(100, seconds=0.05)
    mins, maxs = dsp.envelope(x, 200)
    assert len(mins) == len(maxs) == 200
    assert np.all(mins <= maxs)
    assert maxs.max() == pytest.approx(x.max())


def test_streaming_filter_matches_one_shot_filter():
    from scipy import signal as sps
    rng = np.random.default_rng(1)
    x = rng.normal(0, 0.1, 4800) + 0.3   # includes DC offset
    sos = dsp.design_highpass(FS, 20)
    f = dsp.StreamingFilter(sos)
    chunked = np.concatenate([f(c) for c in np.array_split(x, 7)])
    zi = sps.sosfilt_zi(sos) * x[0]
    whole, _ = sps.sosfilt(sos, x, zi=zi)
    np.testing.assert_allclose(chunked, whole, atol=1e-10)


def test_highpass_removes_dc():
    f = dsp.StreamingFilter(dsp.design_highpass(FS, 20))
    y = f(np.full(int(FS), 0.5))
    assert abs(y[-1000:].mean()) < 1e-3


def test_noise_floor_falls_fast_rises_slow():
    nf = dsp.NoiseFloorTracker(fall_tau_s=0.3, rise_db_per_s=1.5)
    for _ in range(40):
        nf.update(-60, 0.05)
    assert nf.floor_db == pytest.approx(-60, abs=0.1)
    for _ in range(10):          # 0.5 s burst at -20 dBFS
        nf.update(-20, 0.05)
    assert nf.floor_db < -59     # rose at most 0.75 dB
    for _ in range(20):
        nf.update(-70, 0.05)
    assert nf.floor_db < -69


def test_quality_priorities():
    kw = dict(silence_dbfs=-70, clip_fraction_limit=0.001, hum_ratio_limit=0.5)
    assert dsp.assess_quality(-30, 0, 0, **kw).label == "ok"
    assert dsp.assess_quality(-90, 0, 0, **kw).label == "no_signal"
    assert dsp.assess_quality(-5, 0.05, 0, **kw).label == "clipping"
    q = dsp.assess_quality(-30, 0.05, 0.9, **kw)
    assert q.label == "clipping" and len(q.reasons) == 2
    assert dsp.assess_quality(-30, 0, 0.9, **kw).label == "mains_hum"
