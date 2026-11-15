import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addPracticeMark, beginPractice, downloadExperiment, injectPulse, PRACTICE_ACTIONS, scorePractice,
  type Category, type PracticeSession, type Pulse,
} from "../lib/practice";
import "./Practice.css";

const seconds = (ms: number) => (ms / 1000).toFixed(1) + " s";
const nameOf = (category: Category) => PRACTICE_ACTIONS.find(action => action.category === category)!.title;

export default function Practice() {
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const origin = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const active = session?.duration === null;
  const now = () => Math.round(performance.now() - origin.current);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setElapsed(now()), 100);
    return () => window.clearInterval(id);
  }, [active]);

  const mark = useCallback((category: Category) => {
    const ms = now();
    setSession(s => s && addPracticeMark(s, category, ms));
  }, []);
  useEffect(() => {
    if (!active) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!panel.current?.getClientRects().length || (event.target instanceof HTMLElement &&
          event.target.closest("input, select, textarea, [contenteditable=true]"))) return;
      const action = PRACTICE_ACTIONS.find(action => action.key === event.key);
      if (action) { event.preventDefault(); mark(action.category); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, mark]);

  function start() {
    origin.current = performance.now();
    setElapsed(0);
    setSession(beginPractice(Date.now()));
  }
  function pulse(channel: Pulse) {
    const ms = now();
    setSession(s => s && injectPulse(s, channel, ms));
    setElapsed(ms);
  }
  function finish() {
    const ms = now();
    setSession(s => s && { ...s, duration: ms });
    setElapsed(ms);
  }

  const result = useMemo(() => session?.duration != null ? scorePractice(session) : null, [session]);
  const left = Math.max(0, elapsed - 10_000);
  const lastMark = session?.marks.at(-1);
  const lastCandidate = session?.candidates.at(-1);

  return <section ref={panel} className="card practice" aria-labelledby="practice-heading">
    <div className="practice-heading">
      <div>
        <h2 id="practice-heading">Mesa de simulación</h2>
        <p className="muted">Genera pulsos de audio y movimiento para probar el detector sin conectar sensores.</p>
      </div>
      {active
        ? <button className="btn btn-ghost" onClick={finish}>Finalizar práctica</button>
        : <button className="btn btn-primary" onClick={start}>{session ? "Nueva práctica" : "Iniciar práctica"}</button>}
    </div>

    {session && <>
      <div className="practice-monitor">
        <div className="practice-monitor-head"><h3>Pulsos simulados</h3><strong className="tabular">{seconds(elapsed)}</strong></div>
        {(["audio", "motion"] as const).map(channel =>
          <div className="practice-trace" key={channel}>
            <span>{channel === "audio" ? "Audio" : "Movimiento"}</span>
            <div className="practice-track" aria-hidden="true">
              {session.recentPulses.filter(p => p.channel === channel && p.ms >= left).map((p, i) =>
                <i key={i} className={channel} style={{ left: (p.ms - left) / 100 + "%" }} />)}
            </div>
          </div>)}
        <div className="practice-axis" aria-hidden="true"><span>{seconds(left)}</span><span>{seconds(left + 10000)}</span></div>
      </div>

      {active && <div className="practice-work">
        <div>
          <h3>Generar pulsos</h3>
          <p>Dos pulsos de canales distintos en un intervalo de hasta 0,65 s generan un candidato. El detector vuelve a aceptar pulsos tras 1,5 s.</p>
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("audio")}>Audio</button>
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("motion")}>Movimiento</button>
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("both")}>Ambos a la vez</button>
          </div>
          <p role="status">{lastCandidate ? "Candidatos: " + session.candidates.length + " · Último a " + seconds(lastCandidate.ms) : "Esperando la primera coincidencia."}</p>
        </div>
        <div>
          <h3>Marcar una acción</h3>
          <p>Elige la acción que representa el ensayo o pulsa su tecla. Puedes marcarla incluso si el detector guarda silencio.</p>
          <div className="row">{PRACTICE_ACTIONS.map(action =>
            <button key={action.key} className="btn btn-ghost btn-sm" onClick={() => mark(action.category)}>
              {action.title}<kbd>{action.key}</kbd>
            </button>)}</div>
          <p role="status">{lastMark ? "Marcas: " + session.marks.length + " · " + nameOf(lastMark.category) + " a " + seconds(lastMark.ms) : "Aún no hay marcas."}</p>
        </div>
      </div>}

      {result && <div className="practice-report">
        <h3>Resultado de la simulación</h3>
        <p>Se compararon {session.candidates.length} candidatos y {session.marks.length} marcas con una tolerancia de ±1,5 s. Saliva y agua son las dos etiquetas positivas.</p>
        <div className="metrics">{[["Aciertos", result.tp], ["Falsas alarmas", result.fp], ["Omisiones", result.fn]].map(([label, value]) =>
          <div key={label} className="metric"><span>{label}</span><strong>{value}</strong></div>)}</div>
        <button className="btn btn-ghost" onClick={() => downloadExperiment(session, "simulation")}>Descargar CSV de práctica (.zip)</button>
        <p className="muted small">Descomprime el ZIP para abrir la carpeta en el visor de sesiones.</p>
      </div>}
    </>}
  </section>;
}
