import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
