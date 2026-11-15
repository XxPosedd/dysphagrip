import { useEffect, useMemo, useState } from "react";
import { Waveform } from "../components/Waveform";
import { Spectrogram } from "../components/Spectrogram";
import { MotionChart } from "../components/MotionChart";
import { Chip, QualityPanel } from "../components/Panels";
import type { MonitorService } from "../hooks/useMonitor";
import type { AudioService } from "../hooks/useAudioService";
import type { FrameListener } from "../hooks/useAudioService";
import { formatDuration } from "../lib/format";
import type { CandidateEvent } from "../lib/monitorTypes";

const CAT_LABEL: Record<string, string> = {
  swallow_candidate: "Swallow candidate",
  motion_artifact: "Motion artifact",
  unclassified_activity: "Unclassified activity",
  baseline_idle: "Baseline / idle",
};

function EventTimeline({ events, elapsed }: { events: CandidateEvent[]; elapsed: number }) {
  const maxT = Math.max(elapsed, 1);
  return (
    <div className="event-timeline">
      <div className="event-track">
        {events.map((e) => (
          <div
            key={e.id}
            className={`event-mark cat-${e.category}`}
            style={{ left: `${Math.min(98, (e.session_t_ms / maxT) * 100)}%` }}
            title={`${CAT_LABEL[e.category] || e.category} · score ${e.heuristic_score.toFixed(2)}`}
          />
        ))}
      </div>
      <div className="axis-x"><span>0</span><span>{formatDuration(elapsed)}</span></div>
    </div>
  );
}

export function LivePage({ monitor, audio }: { monitor: MonitorService; audio: AudioService }) {
  const monitoring = monitor.session?.monitoring ?? false;
  const elapsed = monitor.session?.elapsed_ms ?? 0;
  const metrics = monitor.session?.metrics;
  const demo = monitor.mode === "demo";

  // Bridge: Waveform/Spectrogram expect AudioFrame subscribers.
  // In demo/live monitoring, prefer monitor live frames; otherwise fall back to raw audio WS.
  const waveSubscribe = useMemo(() => {
    return (fn: FrameListener) => {
      if (monitoring || demo) {
        return monitor.subscribe((msg) => {
          if (msg.audio) fn(msg.audio);
        });
      }
      return audio.subscribe(fn);
    };
  }, [monitoring, demo, monitor, audio]);

  const [device, setDevice] = useState<number | null>(null);
  const [channel, setChannel] = useState(0);

  useEffect(() => {
    if (audio.status?.source?.device_index !== undefined) {
      setDevice(audio.status.source.device_index);
      setChannel(audio.status.source.channel ?? 0);
      return;
    }
    if (device !== null || !audio.devices.length) return;
    const def = audio.um2Candidate ?? audio.devices.find((d) => d.is_default)?.index ?? audio.devices[0].index;
    setDevice(def);
    setChannel(audio.um2Candidate !== null ? 1 : 0);
  }, [audio.devices, audio.um2Candidate, audio.status?.source, device]);

  const selected = audio.devices.find((d) => d.index === device);
  const audioLive = demo ? monitoring : (audio.status?.running ?? false);
  const imuState = monitor.imuStatus?.state ?? "disconnected";

  const startAll = async () => {
    if (!demo && !audio.status?.running) {
      const s = await audio.start(device, channel);
      if (!s?.running) return;
    }
    await monitor.startMonitoring();
  };

  const stopAll = async () => {
    await monitor.stopMonitoring();
  };

  return (
    <div className="page live-page">
      <header className="page-head">
        <div>
          <h1>Live Monitoring</h1>
          <p className="lede">Synchronised acoustic + biomechanical streams with experimental event heuristics.</p>
        </div>
        <div className="head-actions">
          <div className={`timer tabular ${monitoring ? "rec" : ""}`}>
            {monitoring && <span className="rec-dot" />}
            {formatDuration(elapsed)}
          </div>
          {monitoring ? (
            <button className="btn btn-stop" disabled={monitor.busy} onClick={() => void stopAll()}>Stop Monitoring</button>
          ) : (
            <button className="btn btn-primary" disabled={monitor.busy || (!demo && (audio.connection !== "open" || device === null))}
              onClick={() => void startAll()}>Start Monitoring</button>
          )}
          <button className="btn btn-ghost" disabled={monitor.busy || monitoring} onClick={() => void monitor.calibrate()}>Calibrate Baseline</button>
          <button className="btn btn-ghost" disabled={monitor.busy} onClick={() => void monitor.resetSession()}>Reset</button>
        </div>
      </header>

      {monitor.error && <div className="banner-error" role="alert">{monitor.error}</div>}
      {monitor.flashEvent && (
        <div className={`event-flash cat-${monitor.flashEvent.category}`} role="status">
          <strong>{CAT_LABEL[monitor.flashEvent.category] || monitor.flashEvent.category}</strong>
          <span>Heuristic score {monitor.flashEvent.heuristic_score.toFixed(2)} · {monitor.flashEvent.reason}</span>
        </div>
      )}

      <section className="controls card-flat">
        {!demo && (
          <div className="control-group">
            <label>USB audio input
              <select value={device ?? ""} disabled={audio.status?.running || !audio.devices.length}
                onChange={(e) => { setDevice(Number(e.target.value)); setChannel(0); }}>
                {!audio.devices.length && <option value="">No devices — is the signal service running?</option>}
                {audio.devices.map((d) => (
                  <option key={d.index} value={d.index}>
                    {d.name}
                    {d.um2_match === "strong" ? " ★ interface" : d.usb_audio_match === "strong" ? " ★ USB audio" : ""}
                    {d.is_default ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>Channel
              <select value={channel} disabled={!!audio.status?.running || !selected}
                onChange={(e) => setChannel(Number(e.target.value))}>
                {Array.from({ length: selected?.max_input_channels ?? 1 }, (_, c) => (
                  <option key={c} value={c}>Input {c + 1}</option>
                ))}
              </select>
            </label>
            {audio.status?.running
              ? <button className="btn btn-ghost" disabled={monitoring || audio.busy} onClick={() => void audio.stop()}>Stop input</button>
              : <button className="btn btn-ghost" disabled={audio.busy || device === null} onClick={() => void audio.start(device, channel)}>Start input</button>}
            <button className="btn btn-ghost btn-icon" onClick={() => void audio.refreshDevices()} title="Refresh devices">↻</button>
          </div>
        )}
        <div className="chips" aria-label="Device status">
          <Chip tone={monitor.connection === "open" ? "good" : "critical"}>WebSocket</Chip>
          <Chip tone={demo || audioLive ? "good" : "neutral"}>{demo ? "Audio · demo" : audioLive ? "Audio · live" : "Audio · stopped"}</Chip>
          <Chip tone={imuState === "connected" ? "good" : imuState === "stale" ? "warning" : imuState === "error" ? "critical" : "neutral"}>
            IMU · {demo ? "demo" : imuState}
          </Chip>
          <Chip tone={monitoring ? "info" : "neutral"}>{monitoring ? "Monitoring" : "Idle"}</Chip>
        </div>
      </section>

      {monitor.calibration?.running && (
        <div className="calib-bar card-flat">
          <div className="calib-meta">
            <strong>Calibrating baseline</strong>
            <span className="muted small">Remain relatively still · experimental thresholds only</span>
          </div>
          <div className="progress"><div style={{ width: `${Math.round((monitor.calibration.progress || 0) * 100)}%` }} /></div>
          <div className="muted small tabular">
            RMS {monitor.calibration.latest_rms_dbfs?.toFixed(1) ?? "—"} dBFS · motion {monitor.calibration.latest_motion_energy?.toFixed(3) ?? "—"}
          </div>
        </div>
      )}
      {monitor.calibration?.result?.completed && !monitor.calibration.running && (
        <p className="muted small">Calibration complete — suggested activity {monitor.calibration.result.suggested_activity_db} dB,
          motion artifact {monitor.calibration.result.suggested_motion_artifact}. {monitor.calibration.result.disclaimer}</p>
      )}

      <div className="metrics-strip">
        <div className="metric-tile"><span>Duration</span><strong className="tabular">{formatDuration(elapsed)}</strong></div>
        <div className="metric-tile"><span>Swallow candidates</span><strong className="tabular">{metrics?.swallow_candidates ?? 0}</strong></div>
        <div className="metric-tile"><span>Motion artifacts</span><strong className="tabular">{metrics?.motion_artifacts ?? 0}</strong></div>
        <div className="metric-tile"><span>Acoustic level</span><strong className="tabular">{monitor.latestAudio ? `${monitor.latestAudio.features.rms_dbfs.toFixed(1)} dBFS` : "—"}</strong></div>
        <div className="metric-tile"><span>Motion energy</span><strong className="tabular">{monitor.imuFeatures ? monitor.imuFeatures.motion_energy.toFixed(3) : "—"}</strong></div>
        <div className="metric-tile"><span>Signal quality</span><strong>{monitor.latestAudio?.quality.label ?? "—"}</strong></div>
      </div>

      <div className="grid-live">
        <section className="card-flat span-plots">
          <Waveform subscribe={waveSubscribe} live={audioLive || monitoring} />
          <Spectrogram subscribe={waveSubscribe} live={audioLive || monitoring} />
          <MotionChart samples={monitor.imuHistory} live={monitoring || imuState === "connected"} />
        </section>
        <aside className="stack">
          <QualityPanel frame={monitor.latestAudio ?? audio.latest} stable={null} />
          <section className="card-flat">
            <header className="card-head"><h2>IMU readout</h2>
              <Chip tone={imuState === "connected" || demo ? "good" : "neutral"}>{demo ? "Demo" : imuState}</Chip>
            </header>
            {monitor.latestImu ? (
              <div className="metrics">
                <div className="metric"><span>Ax</span><strong className="tabular">{monitor.latestImu.ax.toFixed(3)} g</strong></div>
                <div className="metric"><span>Ay</span><strong className="tabular">{monitor.latestImu.ay.toFixed(3)} g</strong></div>
                <div className="metric"><span>Az</span><strong className="tabular">{monitor.latestImu.az.toFixed(3)} g</strong></div>
                <div className="metric"><span>|a|</span><strong className="tabular">{monitor.latestImu.accel_mag.toFixed(3)} g</strong></div>
                <div className="metric"><span>|ω|</span><strong className="tabular">{monitor.latestImu.gyro_mag.toFixed(1)} °/s</strong></div>
              </div>
            ) : (
              <p className="muted small">No IMU samples. Connect UNO Q in Device Setup, or use Demo Mode.</p>
            )}
          </section>
        </aside>
      </div>

      <section className="card-flat">
        <header className="card-head">
          <h2>Event detection timeline</h2>
          <span className="muted small">Experimental heuristics · not clinical labels</span>
        </header>
        <EventTimeline events={monitor.events} elapsed={elapsed || 1} />
        <ol className="event-list">
          {[...monitor.events].reverse().slice(0, 12).map((e) => (
            <li key={e.id}>
              <span className={`badge cat-${e.category}`}>{CAT_LABEL[e.category] || e.category}</span>
              <span className="tabular muted">{formatDuration(e.session_t_ms)}</span>
              <span className="grow">{e.reason}</span>
              <span className="tabular muted">h={e.heuristic_score.toFixed(2)}</span>
            </li>
          ))}
          {!monitor.events.length && <li className="muted">No candidate events yet.</li>}
        </ol>
      </section>
    </div>
  );
}
