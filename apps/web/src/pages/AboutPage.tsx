import { ResourcesPanel } from "../components/Resources";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function AboutPage() {
  const [bright, setBright] = useState(false);
  useEffect(() => {
    void api.health().then((h) => setBright(h.integrations.brightdata)).catch(() => setBright(false));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Research limitations</h1>
          <p className="lede">What DysphaGrip measures — and what it must not be used for.</p>
        </div>
      </header>

      <section className="card-flat prose">
        <h2>This is an experimental sensing prototype</h2>
        <p>
          DysphaGrip captures contact vibration (acoustic) and biomechanical motion near the throat,
          computes explainable signal features, and labels <em>candidate</em> events with rule-based heuristics.
        </p>
        <ul>
          <li>It does <strong>not</strong> diagnose dysphagia.</li>
          <li>It does <strong>not</strong> detect aspiration, silent aspiration, or pharyngeal residue.</li>
          <li>It cannot confirm that a swallow is safe or unsafe.</li>
          <li>Heuristic scores are not clinical probabilities.</li>
          <li>It must not be used for feeding, treatment, or emergency decisions.</li>
        </ul>
        <h2>What the signals represent</h2>
        <p>
          Acoustic RMS / envelope / spectrum describe mechanical vibration at the contact pickup.
          IMU magnitude describes movement of the sensor mount. Fusion rules look for acoustic bursts
          with limited motion (swallow candidate) versus high-motion bursts (artifact). These are
          engineering indicators for demo and research exploration only.
        </p>
        <h2>Hardware honesty</h2>
        <p>
          Live Mode reports real connection state. Missing hardware is shown as disconnected — never
          silently replaced. Demo Mode is explicitly labelled <strong>SIMULATED DEMO DATA</strong>.
        </p>
      </section>

      <ResourcesPanel brightDataConfigured={bright} />
    </div>
  );
}
