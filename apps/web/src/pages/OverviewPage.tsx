import { Link } from "react-router-dom";
import { Activity, Cpu, ShieldAlert } from "lucide-react";
import type { MonitorService } from "../hooks/useMonitor";
import type { AudioService } from "../hooks/useAudioService";
import { Chip } from "../components/Panels";

export function OverviewPage({ monitor, audio }: { monitor: MonitorService; audio: AudioService }) {
  const imu = monitor.imuStatus?.state ?? "disconnected";
  return (
    <div className="page overview">
      <header className="hero-panel">
        <p className="eyebrow">SanD Hacks 2026 · research prototype</p>
        <h1>DysphaGrip</h1>
        <p className="hero-lede">
          Multimodal swallowing signal monitoring — contact acoustics and throat-adjacent motion,
          fused into experimental candidate events in real time.
        </p>
        <div className="hero-cta">
          <Link className="btn btn-primary" to="/live">Open Live Monitoring</Link>
          <button className="btn btn-ghost" type="button" onClick={() => void monitor.setMode("demo")}>
            Launch Demo Mode
          </button>
        </div>
      </header>

      <div className="status-grid">
        <div className="status-card">
          <h3>USB Audio</h3>
          <Chip tone={audio.connection === "open" ? (audio.status?.running ? "good" : "neutral") : "critical"}>
            {audio.connection === "open" ? (audio.status?.running ? "Capturing" : "Service ready") : "Offline"}
          </Chip>
          <p className="muted small">Cherub / contact pickup → USB interface → MacBook</p>
        </div>
        <div className="status-card">
          <h3>Arduino UNO Q · MPU-6050</h3>
          <Chip tone={imu === "connected" ? "good" : imu === "error" ? "critical" : "neutral"}>{imu}</Chip>
          <p className="muted small">{monitor.imuStatus?.endpoint || "Not connected — see Device Setup"}</p>
        </div>
        <div className="status-card">
          <h3>Mode</h3>
          <Chip tone={monitor.mode === "demo" ? "warning" : "info"}>{monitor.mode === "demo" ? "Demo" : "Live"}</Chip>
          <p className="muted small">Demo never silently replaces missing hardware.</p>
        </div>
      </div>

      <section className="card-flat steps">
        <h2>Demo sequence</h2>
        <ol>
          <li><Activity size={16} /> Open Live Monitoring and confirm device chips.</li>
          <li><Cpu size={16} /> Start monitoring (Demo Mode works without sensors).</li>
          <li>Watch acoustic + IMU charts; swallow or wait for scripted demo events.</li>
          <li>Review the event timeline, stop, and export from Sessions.</li>
        </ol>
      </section>

      <p className="disclaimer-inline">
        <ShieldAlert size={16} /> <strong>Not a medical device.</strong> DysphaGrip does not diagnose dysphagia,
        detect aspiration, or confirm safe swallowing. All classifications are experimental heuristics.
      </p>
    </div>
  );
}
