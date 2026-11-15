import Practice from "./components/Practice";
import Proyecto2 from "./components/Proyecto2";
import comparison from "./assets/comparacion-saliva-movimiento.png";
import "./laboratorio.css";

export default function Laboratorio() {
  return (
    <div className="lab">
      <header className="lab-header">
        <span className="lab-brand">DysphaGrip</span>
        <nav aria-label="Secciones del laboratorio">
          <a href="#practica">Práctica</a>
          <a href="#sesiones">Sesiones</a>
          <a href="?vista=monitor" target="_blank" rel="noreferrer">Monitor en vivo ↗</a>
        </nav>
      </header>
      <main className="lab-main">
        <div className="lab-intro">
          <span className="lab-project">Proyecto 2</span>
          <h1>Laboratorio de señales</h1>
          <p>Explora cómo coinciden el sonido del micrófono de contacto y el movimiento del MPU6050.
            Puedes ensayar con señales simuladas o revisar una sesión guardada.</p>
        </div>
        <section id="practica" aria-label="Práctica con señales simuladas"><Practice /></section>
        <section id="sesiones" aria-label="Sesiones guardadas"><Proyecto2 /></section>
        <details className="lab-reference" open>
          <summary>Saliva y movimiento de cabeza · comparación del prototipo</summary>
          <figure>
            <img src={comparison} loading="lazy" width="1458" height="802"
              alt="La marca 2 de saliva presenta un pico de audio sin detección. La marca 12 de movimiento de cabeza sí presenta una detección." />
            <figcaption>Dos marcas de una sesión previa. El tiempo cero indica la etiqueta manual.
              La línea naranja señala una detección durante el movimiento de cabeza.</figcaption>
          </figure>
        </details>
      </main>
      <footer className="lab-footer">Prototipo experimental de DysphaGrip. Los eventos candidatos requieren revisión y carecen de validación clínica.</footer>
    </div>
  );
}
