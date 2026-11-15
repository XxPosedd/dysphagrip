import { NavLink, Outlet } from "react-router-dom";
import { Activity, Cpu, FlaskConical, Info, LayoutDashboard, Radio } from "lucide-react";
import type { AppMode } from "../../lib/monitorTypes";

const NAV = [
  { to: "/", end: true, label: "Overview", icon: LayoutDashboard },
  { to: "/live", label: "Live Monitoring", icon: Activity },
  { to: "/sessions", label: "Sessions", icon: Radio },
  { to: "/setup", label: "Device Setup", icon: Cpu },
  { to: "/about", label: "Research Limits", icon: Info },
];

export function Shell({
  mode, onMode, demo, wsOk, monitoring,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  demo: boolean;
  wsOk: boolean;
  monitoring: boolean;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden>
            <FlaskConical size={22} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">DysphaGrip</div>
            <div className="brand-tag">Multimodal Swallowing Signal Monitoring</div>
          </div>
        </div>
        <nav className="side-nav" aria-label="Primary">
          {NAV.map(({ to, end, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <Icon size={18} strokeWidth={2} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div className="mode-switch" role="group" aria-label="Acquisition mode">
            <button type="button" className={mode === "live" ? "on" : ""} onClick={() => onMode("live")}>Live</button>
            <button type="button" className={mode === "demo" ? "on" : ""} onClick={() => onMode("demo")}>Demo</button>
          </div>
          <div className="side-status">
            <span className={`dot ${wsOk ? "ok" : "bad"}`} /> Backend {wsOk ? "connected" : "offline"}
            {monitoring && <span className="rec-pill">REC</span>}
          </div>
        </div>
      </aside>
      <div className="main-col">
        {demo && (
          <div className="demo-banner" role="status">SIMULATED DEMO DATA — not live sensor readings</div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
