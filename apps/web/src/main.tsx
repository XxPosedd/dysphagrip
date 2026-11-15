import React from "react";
import ReactDOM from "react-dom/client";
import Laboratorio from "./Laboratorio";
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

const monitor = new URLSearchParams(window.location.search).get("vista") === "monitor";
document.documentElement.lang = monitor ? "en" : "es";
document.title = monitor ? "DysphaGrip · Live monitor" : "Proyecto 2 · DysphaGrip";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {monitor ? <>
        <nav className="monitor-return"><a href="?">← Laboratorio de Proyecto 2</a></nav>
        <React.Suspense fallback={<p role="status" className="app">Abriendo monitor…</p>}><Monitor /></React.Suspense>
      </> : <Laboratorio />}
    </ErrorBoundary>
  </React.StrictMode>,
);
