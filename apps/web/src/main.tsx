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

// The live monitor is the default page; the signal lab is at ?view=lab (legacy ?vista=monitor still opens the monitor).
const params = new URLSearchParams(window.location.search);
const monitor = params.get("view") !== "lab";
document.documentElement.lang = "en";
document.title = monitor ? "DysphaGrip — Experimental Signal Monitor" : "Signal lab · DysphaGrip";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {monitor ? <>
        <nav className="monitor-return"><a href="?view=lab">Signal lab (practice and session review) →</a></nav>
        <React.Suspense fallback={<p role="status" className="app">Opening monitor…</p>}><Monitor /></React.Suspense>
      </> : <Laboratorio />}
    </ErrorBoundary>
  </React.StrictMode>,
);
