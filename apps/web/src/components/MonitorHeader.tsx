import type { ReactNode } from "react";

export default function MonitorHeader({ children }: { children: ReactNode }) {
  return <header className="topbar">
    <div className="brand"><div className="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 12h4l2-6 4 12 3-9 2 3h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div><div><h1>DysphaGrip</h1><p className="muted small">Experimental swallowing-signal monitor</p></div></div>
    <nav aria-label="Dashboard sections">{children}</nav>
  </header>;
}
