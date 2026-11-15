import numpy as np
from scipy.signal import welch
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

FS = 4000  # Deck's dataset sample rate
WINDOW_SECONDS = 0.25
STEP_SECONDS = 0.05


def features(window):
    """
    window shape: (samples, 4)
    columns: microphone, A-P, S-I, M-L

    The deck describes accelerometer axes as acceleration, not
    direct measurements of hyoid displacement.
    """
    result = []

    for channel in range(window.shape[1]):
        x = window[:, channel].astype(float)
        x -= x.mean()

        rms = np.sqrt(np.mean(x**2))
        peak = np.max(np.abs(x))
        std = np.std(x)

        freqs, power = welch(x, fs=FS, nperseg=min(len(x), 512))
        total_power = power.sum() + 1e-12
        centroid = np.sum(freqs * power) / total_power
        bandwidth = np.sqrt(
            np.sum(((freqs - centroid) ** 2) * power) / total_power
        )

        result.extend([rms, peak, std, centroid, bandwidth])

    return np.array(result)


def extract_windows(signal):
    """signal: (samples, 4) array of synchronized mic + XYZ recordings."""
    size = int(WINDOW_SECONDS * FS)
    step = int(STEP_SECONDS * FS)

    windows, times = [], []
    for start in range(0, len(signal) - size + 1, step):
        windows.append(signal[start:start + size])
        times.append(start / FS)

    return np.asarray(windows), np.asarray(times)


def train_reference_model(typical_swallow_signals):
    """
    typical_swallow_signals: list of arrays, each shaped (samples, 4).
    These must be clinician-reviewed reference examples for the intended
    population and recording setup.
    """
    rows = []
    for signal in typical_swallow_signals:
        windows, _ = extract_windows(signal)
        rows.extend(features(w) for w in windows)

    if not rows:
        raise ValueError("No windows available to train the reference model.")

    model = make_pipeline(
        StandardScaler(),
        IsolationForest(
            n_estimators=300,
            contamination=0.05,  # Expected outlier fraction; tune on validation data
            random_state=42,
        ),
    )
    model.fit(np.asarray(rows))
    return model


def flag_unusual_windows(model, recording):
    """
    Returns window start times and anomaly scores.
    Higher anomaly scores mean more unusual relative to the reference set.
    """
    windows, times = extract_windows(recording)
    X = np.asarray([features(w) for w in windows])

    # IsolationForest decision_function: lower means more unusual.
    scores = -model.decision_function(X)
    flagged = model.predict(X) == -1

    return [
        {
            "start_seconds": float(t),
            "anomaly_score": float(score),
            "flagged_for_review": bool(is_outlier),
        }
        for t, score, is_outlier in zip(times, scores, flagged)
    ]