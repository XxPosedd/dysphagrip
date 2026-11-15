import { useEffect, useRef, useState } from "react";
import { openExperiment, readMotion, type CsvRow, type Experiment, type MotionSample } from "../lib/experiment";
import { PRACTICE_ACTIONS } from "../lib/practice";
import "./Proyecto2.css";

function categoryName(category: string) {
  return PRACTICE_ACTIONS.find((a) => a.category === category)?.title ?? category;
}

function number(value: string | undefined, digits = 2) {
  return value?.trim() && Number.isFinite(Number(value))
    ? Number(value).toLocaleString("es-MX", { maximumFractionDigits: digits }) : "—";
}

function MotionPlot({ samples, rotation }: { samples: MotionSample[]; rotation: boolean }) {
  const title = rotation ? "Giro (°/s)" : "Aceleración (g)";
  const offset = rotation ? 3 : 0;
  const limit = samples.reduce((max, { axes }) =>
    Math.max(max, ...axes.slice(offset, offset + 3).map(Math.abs)), 0) || 1;
  const start = samples.reduce((min, { seconds }) => Math.min(min, seconds), -2);
  const end = samples.reduce((max, { seconds }) => Math.max(max, seconds), 2);
  const x = (seconds: number) => 2 + (seconds - start) / (end - start) * 396;
  return <figure className="exp-plot">
    <figcaption>{title}</figcaption>
    <div className="exp-chart-range"><span>+{limit.toPrecision(3)}</span><span>−{limit.toPrecision(3)}</span></div>
    <svg viewBox="0 0 400 90" preserveAspectRatio="none" role="img" aria-label={title + " en los ejes X, Y y Z"}>
      <line x1="0" y1="45" x2="400" y2="45" />
      <line x1={x(0)} y1="0" x2={x(0)} y2="90" strokeDasharray="3 3" />
      {[0, 1, 2].map((axis) => {
        const points = samples.map(({ seconds, axes }) => [x(seconds), 45 - axes[offset + axis] / limit * 42]);
        return points.length === 1
          ? <circle key={axis} cx={points[0][0]} cy={points[0][1]} r="2" fill={`var(--series-${axis + 1})`} />
          : <polyline key={axis} fill="none" stroke={`var(--series-${axis + 1})`}
              vectorEffect="non-scaling-stroke" points={points.map((p) => p.join(",")).join(" ")} />;
      })}
    </svg>
    <div className="exp-chart-time"><span>{start} s</span><span>Marca · 0 s</span><span>+{end} s</span></div>
  </figure>;
}

/* WAVs may begin after the requested window when the input was interrupted.
 * Draw the envelope at the offset saved by LabelCapture, using the decoded rate. */
function AudioPlot({ file, start }: { file: File; start: number }) {
  const [plot, setPlot] = useState<{ path: string; limit: number } | null>(null);
  useEffect(() => {
    let active = true;
    async function decode() {
      const context = new OfflineAudioContext(1, 1, 48000);
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      const samples = decoded.getChannelData(0);
      const step = Math.max(1, Math.ceil(samples.length / 400));
      const limit = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0) || 1;
      const columns = [];
      for (let i = 0; i < samples.length; i += step) {
        let low = samples[i];
        let high = samples[i];
        for (let j = i + 1; j < Math.min(i + step, samples.length); j++) {
          low = Math.min(low, samples[j]);
          high = Math.max(high, samples[j]);
        }
        const x = (start + i / decoded.sampleRate + 2) * 100;
        columns.push(`M${x.toFixed(2)} ${45 - 43 * low / limit}V${45 - 43 * high / limit}`);
      }
      if (active) setPlot({ path: columns.join(" "), limit });
    }
    // Native audio controls still work on browsers without offline WAV decoding.
    void decode().catch(() => {});
    return () => { active = false; };
  }, [file, start]);
  if (!plot) return null;
  return <figure className="exp-plot">
    <figcaption>Audio del micrófono · amplitud normalizada</figcaption>
    <div className="exp-chart-range"><span>+{plot.limit.toPrecision(3)}</span><span>−{plot.limit.toPrecision(3)}</span></div>
    <svg viewBox="0 0 400 90" preserveAspectRatio="none" role="img" aria-label="Envolvente de audio respecto a la marca">
      <line x1="0" y1="45" x2="400" y2="45" />
      <path d={plot.path} fill="none" stroke="var(--series-audio)" vectorEffect="non-scaling-stroke" />
      <line x1="200" y1="0" x2="200" y2="90" strokeDasharray="3 3" />
    </svg>
    <div className="exp-chart-time"><span>−2 s</span><span>Marca · 0 s</span><span>+2 s</span></div>
  </figure>;
}

type CaptureData = { samples: MotionSample[]; metadata: Record<string, unknown> | null; errors: string[] };

function Capture({ session, label }: { session: Experiment; label: CsvRow }) {
  const dir = "captures/mark_" + label.label_id.padStart(4, "0") + "/";
  const wav = session.files.get(dir + "audio.wav");
  const motion = session.files.get(dir + "motion.csv");
  const meta = session.files.get(dir + "metadata.json");
  const [audioUrl, setAudioUrl] = useState("");
  const [capture, setCapture] = useState<CaptureData | null>(null);
  useEffect(() => {
    if (!wav) return;
    const url = URL.createObjectURL(wav);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [wav]);
  useEffect(() => {
    let active = true;
    async function load() {
      const [trace, info] = await Promise.allSettled([
        motion ? motion.text().then(readMotion) : Promise.resolve([]),
        meta ? meta.text().then((json) => JSON.parse(json)) : Promise.resolve(null),
      ]);
      if (!active) return;
      const errors = [];
      if (trace.status === "rejected") errors.push("No se pudo leer motion.csv.");
      if (info.status === "rejected") errors.push("No se pudo leer metadata.json.");
      setCapture({
        samples: trace.status === "fulfilled" ? trace.value : [],
        metadata: info.status === "fulfilled" && info.value && typeof info.value === "object" ? info.value : null,
        errors,
      });
    }
    void load();
    return () => { active = false; };
  }, [motion, meta]);
  if (!wav && !motion && !meta) return <p className="muted">Esta marca se guardó sin archivos de captura.</p>;
  if (!capture) return <p role="status">Leyendo captura…</p>;
  const { samples, metadata, errors } = capture;
  return <div className="exp-capture">
    {metadata?.closed_before_window_end === true && <p>La sesión terminó antes de completar la ventana de esta marca.</p>}
    {typeof metadata?.audio_recorded_frames === "number" && typeof metadata.sample_rate_hz === "number" && metadata.sample_rate_hz > 0 &&
      <p className="muted">Audio registrado · {metadata.audio_recorded_frames.toLocaleString("es-MX")} muestras a {metadata.sample_rate_hz.toLocaleString("es-MX")} Hz
        {Array.isArray(metadata.audio_missing_intervals_seconds_from_mark) && metadata.audio_missing_intervals_seconds_from_mark.length > 0
          ? ` · ${metadata.audio_missing_intervals_seconds_from_mark.length} intervalos sin audio` : ""}</p>}
    {wav && typeof metadata?.wav_start_seconds_from_mark === "number" &&
      <AudioPlot file={wav} start={metadata.wav_start_seconds_from_mark} />}
    {audioUrl && metadata?.audio_recorded_frames !== 0
      ? <audio controls preload="metadata" src={audioUrl} aria-label="Audio de la marca" />
      : <p className="muted">Sin audio registrado.</p>}
    {samples.length ? <>
      <div className="exp-traces"><MotionPlot samples={samples} rotation={false} /><MotionPlot samples={samples} rotation /></div>
      <div className="legend"><span>{samples.length} muestras</span>{["X", "Y", "Z"].map((axis, index) =>
        <span key={axis}><i className="sw line" style={{ background: `var(--series-${index + 1})` }} />{axis}</span>)}</div>
    </> : <p className="muted">Sin muestras de movimiento.</p>}
    {errors.map((error) => <p key={error} className="error" role="alert">{error}</p>)}
  </div>;
}

function Report({ session }: { session: Experiment }) {
  const { labels, summary, matches, predictions } = session;
  const [selected, setSelected] = useState(labels[0]?.label_id ?? "");
  const label = labels.find((item) => item.label_id === selected);
  const match = matches?.find((item) => item.label_id === selected);
  const matchByPrediction = new Map(matches?.map((m) => [m.prediction_id, m]));
  const marked = new Map(matches?.map((m) => [m.label_id, m]));
  const categories = [...new Set(labels.map((item) => item.category))];
  const simulated = summary?.disclaimer?.startsWith("SIMULACIÓN");
  return <>
    <section className="card">
      <div className="card-head"><h2>{session.name}</h2>{simulated && <strong>Simulación</strong>}</div>
      {summary ? <>
        <div className="metrics">
          {([["true_positives", "Aciertos"], ["false_positives", "Falsas alarmas"], ["false_negatives", "Omisiones"],
            ["precision", "Precisión"], ["recall", "Sensibilidad"], ["f1", "F1"]] as const).map(([field, title]) =>
            <div key={field} className="metric"><span>{title}</span><strong>{number(summary[field])}</strong></div>)}
        </div>
        <p className="exp-details muted">Duración {number(summary.duration_seconds)} s · Tolerancia {number(summary.tolerance_seconds)} s</p>
      </> : <p className="muted">La carpeta aún no contiene un resumen de la sesión.</p>}
      {categories.length > 0 && <div className="exp-scroll"><table>
        <caption>Comparación por acción</caption>
        <thead><tr><th>Acción</th><th>Marcas</th><th>Con detección</th><th>Sin detección</th></tr></thead>
        <tbody>{categories.map((cat) => {
          const group = labels.filter((row) => row.category === cat);
          const detected = group.filter((row) => marked.has(row.label_id)).length;
          return <tr key={cat}><th scope="row">{categoryName(cat)}</th><td>{group.length}</td>
            <td>{matches ? detected : "—"}</td><td>{matches ? group.length - detected : "—"}</td></tr>;
        })}</tbody>
      </table></div>}
    </section>
    <section className="card exp-capture">
      <div className="card-head"><h2>Capturas por marca</h2></div>
      {label ? <>
        <label>Marca registrada<select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {labels.map((item) => <option key={item.label_id} value={item.label_id}>#{item.label_id} · {categoryName(item.category)}</option>)}
        </select></label>
        <p className="muted">{label.timestamp} · {match ? `Evento #${match.prediction_id} · diferencia ${number(match.latency_seconds, 3)} s`
          : matches ? "Sin detección asociada" : "Correspondencias pendientes"}</p>
        <Capture key={selected} session={session} label={label} />
      </> : <p className="muted">La sesión no contiene marcas manuales.</p>}
    </section>
    <section className="card">
      <div className="card-head"><h2>Eventos del detector</h2></div>
      {predictions?.length ? <div className="exp-scroll"><table>
        <thead><tr><th>Evento</th><th>Instante</th><th>Audio RMS</th><th>Actividad IMU</th><th>Marca asociada</th></tr></thead>
        <tbody>{predictions.map((item) => {
          const linked = matchByPrediction.get(item.event_id);
          return <tr key={item.event_id}><th scope="row">#{item.event_id}</th><td>{item.timestamp}</td>
            <td>{number(item.audio_rms, 5)}</td><td>{number(item.imu_activity, 5)}</td>
            <td>{linked ? `#${linked.label_id} · ${categoryName(linked.category)}` : matches ? "Sin marca" : "Pendiente"}</td></tr>;
        })}</tbody>
      </table></div> : <p className="muted">{predictions ? "La sesión no registró eventos." : "La carpeta aún no contiene predictions.csv."}</p>}
    </section>
  </>;
}

export default function Proyecto2() {
  const input = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<Experiment | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  async function select(files: File[]) {
    if (!files.length) return;
    setLoading(true);
    setError("");
    try {
      const next = await openExperiment(files);
      setSession(next);
      setVersion((previous) => previous + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo leer la carpeta."); }
    finally { setLoading(false); }
  }

  return <div className="exp-view" lang="es">
    <section className="card exp-import">
      <div><h2>Revisar un experimento</h2>
        <p className="muted">Selecciona la carpeta de una sesión de Proyecto 2 que contenga <code>ground_truth.csv</code>.
          Los archivos se leen en este navegador.</p></div>
      <input hidden type="file" multiple {...{ webkitdirectory: "" }} ref={input} onChange={(e) => {
        void select(Array.from(e.target.files ?? []));
        e.target.value = "";
      }} />
      <button className="btn btn-primary" disabled={loading} onClick={() => input.current?.click()}>
        {loading ? "Leyendo…" : session ? "Cambiar carpeta" : "Abrir carpeta"}
      </button>
    </section>
    {error && <p className="banner-error" role="alert">{error}</p>}
    {session && <Report key={version} session={session} />}
  </div>;
}
