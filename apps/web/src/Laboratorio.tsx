import Practice from "./components/Practice";
import Proyecto2 from "./components/Proyecto2";
import comparison from "./assets/comparacion-saliva-movimiento.png";
import "./laboratorio.css";

export default function Laboratorio() {
  return (
    <div className="lab">
      <header className="lab-header">
        <span className="lab-brand">DysphaGrip</span>
        <nav aria-label="Lab sections">
          <a href="#practica">Practice</a>
          <a href="#sesiones">Sessions</a>
          <a href="?">← Live monitor</a>
        </nav>
      </header>
      <main className="lab-main">
        <div className="lab-intro">
          <span className="lab-project">Experimental</span>
          <h1>Signal lab</h1>
          <p>Explore how contact-microphone sound and MPU-6050 movement coincide.
            Practise with clearly labelled simulated signals, or review a saved session.</p>
        </div>
        <section id="practica" aria-label="Practice with simulated signals"><Practice /></section>
        <section id="sesiones" aria-label="Saved sessions"><Proyecto2 /></section>
        <details className="lab-reference" open>
          <summary>Saliva swallow vs head movement · prototype comparison</summary>
          <figure>
            <img src={comparison} loading="lazy" width="1458" height="802"
              alt="Saliva mark 2 shows an audio peak without a detection. Head-movement mark 12 does show a detection." />
            <figcaption>Two marks from an earlier session (chart labels in Spanish). Time zero is the manual label.
              The orange line marks a detection during head movement.</figcaption>
          </figure>
        </details>
      </main>
      <footer className="lab-footer">Experimental DysphaGrip prototype. Candidate events need review and have no clinical validation.</footer>
    </div>
  );
}
