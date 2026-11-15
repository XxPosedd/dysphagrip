import { useEffect, useState } from "react";
import MonitorHeader from "./components/MonitorHeader";
import { ResearchPanel } from "./components/MonitorRecords";
import { Card } from "./components/Panels";
import { useRecordingVoice } from "./hooks/useRecordingVoice";
import { api } from "./lib/api";
import comparison from "./assets/comparacion-saliva-movimiento.png";
import "./live-monitor.css";

export default function PublicDashboard() {
  const voice = useRecordingVoice();
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    api.voice().then(info => {
      if (active) setVoiceAvailable(info.configured || Boolean(info.fallback_provider));
    }).catch(() => { if (active) setVoiceAvailable(false); });
    return () => { active = false; };
  }, []);

  return <main className="app field-monitor">
    <MonitorHeader><a href="#signals">Signals</a><a href="#research">Research</a></MonitorHeader>
    <section id="signals" className="card monitor-toolbar public-overview">
      <div><h2>Swallowing signals</h2>
        <p>A contact microphone measures neck vibrations. A motion sensor measures acceleration and rotation.
          The Mac uses both signals to estimate swallowing, speaking, coughing, head movement, and rest.</p>
      </div>
      <a className="btn btn-ghost" href="?vista=laboratorio#practica">Practice lab (Spanish)</a>
    </section>
    <div className="grid-main">
      <Card title="Recorded signal comparison">
        <figure className="public-recording">
          <a href={comparison} target="_blank" rel="noreferrer" aria-label="Open the full-size recorded signal comparison">
            <img src={comparison} alt="Recorded audio and movement for a saliva swallow the detector missed and a head movement it flagged." width="1458" height="802" />
          </a>
          <figcaption>Two events from a previous session, aligned to their manual marks at zero seconds.
            The orange line marks a detection during head movement.</figcaption>
        </figure>
      </Card>
      <div className="stack">
        <Card title="Recording announcements">
          <p>Hear the cues that play when a recording starts and stops.</p>
          <div className="monitor-controls public-voice" aria-live="polite">
            {voiceAvailable ? <>
              <button className="btn btn-primary" disabled={voice.previewing} onClick={() => void voice.preview()}>
                {voice.previewing ? "Playing preview…" : "Preview voice"}
              </button>
              {voice.provider && <span className="small muted">{voice.provider}</span>}
            </> : <span className="small muted">{voiceAvailable === null ? "Checking voice availability…" : "Voice preview unavailable."}</span>}
            {voice.error && <span className="error">{voice.error}</span>}
          </div>
        </Card>
        <div id="history"><Card title="Recording and session history">
          <p>Start a session on the Mac connected to the microphone and Arduino. The workstation displays live signals,
            accepts manual marks, and keeps recordings private. Session summaries can sync to Neon.</p>
        </Card></div>
      </div>
    </div>
    <ResearchPanel />
  </main>;
}
