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
        <h2 id="practice-heading">Simulation bench <small>(synthetic signals, not measurements)</small></h2>
        <p className="muted">Generate audio and movement pulses to test the detector without sensors.</p>
      </div>
      {active
        ? <button className="btn btn-ghost" onClick={finish}>Finish practice</button>
        : <button className="btn btn-primary" onClick={start}>{session ? "New practice" : "Start practice"}</button>}
    </div>

    {session && <>
      <div className="practice-monitor">
        <div className="practice-monitor-head"><h3>Simulated pulses</h3><strong className="tabular">{seconds(elapsed)}</strong></div>
        {(["audio", "motion"] as const).map(channel =>
          <div className="practice-trace" key={channel}>
            <span>{channel === "audio" ? "Audio" : "Movement"}</span>
            <div className="practice-track" aria-hidden="true">
              {session.recentPulses.filter(p => p.channel === channel && p.ms >= left).map((p, i) =>
                <i key={i} className={channel} style={{ left: (p.ms - left) / 100 + "%" }} />)}
            </div>
          </div>)}
        <div className="practice-axis" aria-hidden="true"><span>{seconds(left)}</span><span>{seconds(left + 10000)}</span></div>
      </div>

      {active && <div className="practice-work">
        <div>
          <h3>Generate pulses</h3>
          <p>Two pulses on different channels within 0.65 s create a candidate. The detector accepts pulses again after 1.5 s.</p>
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("audio")}>Audio</button>
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("motion")}>Movement</button>
            <button className="btn btn-ghost btn-sm" onClick={() => pulse("both")}>Both at once</button>
          </div>
          <p role="status">{lastCandidate ? "Candidates: " + session.candidates.length + " · last at " + seconds(lastCandidate.ms) : "Waiting for the first coincidence."}</p>
        </div>
        <div>
          <h3>Mark an action</h3>
          <p>Choose the action this trial represents, or press its key. You can mark it even if the detector stays silent.</p>
          <div className="row">{PRACTICE_ACTIONS.map(action =>
            <button key={action.key} className="btn btn-ghost btn-sm" onClick={() => mark(action.category)}>
              {action.title}<kbd>{action.key}</kbd>
            </button>)}</div>
          <p role="status">{lastMark ? "Marks: " + session.marks.length + " · " + nameOf(lastMark.category) + " at " + seconds(lastMark.ms) : "No marks yet."}</p>
        </div>
      </div>}

      {result && <div className="practice-report">
        <h3>Simulation result</h3>
        <p>Compared {session.candidates.length} candidates with {session.marks.length} marks at ±1.5 s tolerance. Saliva swallow and water sip are the two positive labels.</p>
        <div className="metrics">{[["Hits", result.tp], ["False alarms", result.fp], ["Misses", result.fn]].map(([label, value]) =>
          <div key={label} className="metric"><span>{label}</span><strong>{value}</strong></div>)}</div>
        <button className="btn btn-ghost" onClick={() => downloadExperiment(session, "simulation")}>Download practice CSVs (.zip)</button>
        <p className="muted small">Unzip it to open the folder in the session viewer.</p>
      </div>}
    </>}
  </section>;
}
