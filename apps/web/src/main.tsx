import React from "react";
import ReactDOM from "react-dom/client";
import LiveMonitor from "./LiveMonitor";
const Laboratorio = React.lazy(() => import("./Laboratorio"));
import "./styles.css";

const Monitor = React.lazy(() => import("./App"));

/** Keeps a rendering error from blanking the whole dashboard during a demo. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("Dashboard error:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <section className="card" role="alert">
          <h2 style={{ marginBottom: 8 }}>The dashboard hit an error</h2>
          <p className="muted small" style={{ marginBottom: 12 }}>{this.state.error.message}</p>
          <button className="btn btn-primary" onClick={() => location.reload()}>Reload dashboard</button>
        </section>
      </div>
    );
  }
}

const view = new URLSearchParams(window.location.search).get("vista");
const workstation = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const instruments = view === "instrumentos" || (!workstation && view === "monitor");
const oldLab = view === "laboratorio" || (!instruments && !workstation) ||
  (!view && ["#practica", "#sesiones"].includes(location.hash));
document.documentElement.lang = oldLab ? "es" : "en";
document.title = oldLab ? "Proyecto 2 · DysphaGrip" : "DysphaGrip · Live monitor";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <React.Suspense fallback={<p className="app" role="status">Loading…</p>}>
        {oldLab ? <Laboratorio /> : instruments ? <>
          <nav className="monitor-return"><a href={workstation ? "?vista=laboratorio" : "?"}>← Laboratorio de Proyecto 2</a></nav>
          <Monitor />
        </> : <LiveMonitor />}
      </React.Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
