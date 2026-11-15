# Research code (not part of the running app)

`anomaly.py` (by Shaheer Ali) is an **experimental, offline** anomaly model: an IsolationForest over
per-window features (RMS, peak, spread, Welch spectrum) for a 4-channel recording (microphone plus 3 accelerometer
axes, 4 kHz) like the public dataset referenced in the team deck.

- It is **not imported by the audio service or the dashboard**. The live "AI anomaly review" tab is separate
  TypeScript code (`apps/web/src/components/AnomalyExplanation.tsx`) that compares live readings with the
  session's own baseline.
- That dataset has swallow timing annotations but **no normal-versus-dysphagia labels**, so this cannot train a
  diagnostic classifier. An "unusual" window is only statistically different from the reference windows.

Install extras: `pip install -r research/requirements-research.txt`
