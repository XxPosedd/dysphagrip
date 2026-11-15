import { useCallback, useEffect, useState } from "react";
import { monitorApi } from "../lib/monitorApi";
import type { ImuStatus, SerialPortInfo } from "../lib/monitorTypes";
import type { AudioDevice } from "../lib/types";
import type { AudioService } from "../hooks/useAudioService";
import { Chip } from "../components/Panels";

export function SetupPage({ audio }: { audio: AudioService }) {
  const [imu, setImu] = useState<ImuStatus | null>(null);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [host, setHost] = useState("192.168.1.50");
  const [tcpPort, setTcpPort] = useState(9001);
  const [serialPort, setSerialPort] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await monitorApi.devices();
      setImu(d.imu.status);
      setPorts(d.imu.serial_ports);
      setDevices(d.audio.devices);
      if (!serialPort && d.imu.serial_ports[0]) setSerialPort(d.imu.serial_ports[0].device);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [serialPort]);

  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 5000); return () => clearInterval(id); }, [refresh]);

  const connectTcp = async () => {
    setMsg(null);
    try {
      const st = await monitorApi.connectImu({ transport: "tcp", host, tcp_port: tcpPort });
      setImu(st);
      setMsg(`IMU TCP connect requested → ${host}:${tcpPort}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const connectSerial = async () => {
    setMsg(null);
    try {
      const st = await monitorApi.connectImu({ transport: "serial", port: serialPort });
      setImu(st);
      setMsg(`IMU serial connect requested → ${serialPort}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Device Setup</h1>
          <p className="lede">Real wiring, transport diagnostics, and connection controls.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => { void refresh(); void audio.refreshDevices(); }}>Refresh</button>
      </header>
      {err && <div className="banner-error">{err}</div>}
      {msg && <div className="banner-info">{msg}</div>}

      <div className="setup-grid">
        <section className="card-flat">
          <h2>Acoustic path</h2>
          <pre className="wiring">{`Cherub WCP-55 (or contact pickup)
        │  6.35 mm instrument cable
        ▼
M-Audio AIR 192|6 / Focusrite / UM2  (phantom OFF)
        │  USB
        ▼
MacBook → Python signal service (sounddevice)`}</pre>
          <p className="muted small">The pickup does <strong>not</strong> connect to an Arduino analog pin.</p>
          <h3 className="sub">Detected inputs</h3>
          <ul className="plain-list">
            {(devices.length ? devices : audio.devices).map((d) => (
              <li key={d.index}>
                <strong>{d.name}</strong>
                <span className="muted"> · {d.max_input_channels} ch · {d.default_samplerate} Hz</span>
                {d.usb_audio_match === "strong" && <Chip tone="good">USB audio</Chip>}
              </li>
            ))}
            {!devices.length && !audio.devices.length && <li className="muted">No devices — start the signal service.</li>}
          </ul>
        </section>

        <section className="card-flat">
          <h2>Biomechanical path</h2>
          <pre className="wiring">{`MPU-6050  --I²C-->  Arduino UNO Q (STM32U585)
                           │
                    Bridge / Serial NDJSON
                           │
              linux_streamer.py (on UNO Q Linux)
                           │  TCP :9001
                           ▼
              MacBook DysphaGrip backend`}</pre>
          <p className="muted small">Typical wiring: VCC→3.3V, GND→GND, SDA→D20, SCL→D21. Verify breakout voltage.</p>
          <div className="chips" style={{ marginBottom: 12 }}>
            <Chip tone={imu?.state === "connected" ? "good" : imu?.state === "error" ? "critical" : "neutral"}>
              IMU {imu?.state ?? "unknown"}
            </Chip>
            {imu?.transport && <Chip tone="info">{imu.transport}</Chip>}
            {imu?.endpoint && <Chip tone="neutral">{imu.endpoint}</Chip>}
          </div>
          {imu?.last_error && <p className="banner-error">{imu.last_error}</p>}

          <h3 className="sub">TCP (recommended)</h3>
          <div className="control-group">
            <label>UNO Q host<input value={host} onChange={(e) => setHost(e.target.value)} /></label>
            <label>Port<input type="number" value={tcpPort} onChange={(e) => setTcpPort(Number(e.target.value))} /></label>
            <button className="btn btn-primary" onClick={() => void connectTcp()}>Connect TCP</button>
          </div>

          <h3 className="sub">Serial (only if macOS exposes a port)</h3>
          <div className="control-group">
            <label>Port
              <select value={serialPort} onChange={(e) => setSerialPort(e.target.value)}>
                {!ports.length && <option value="">No serial ports listed</option>}
                {ports.map((p) => <option key={p.device} value={p.device}>{p.device} · {p.description}</option>)}
              </select>
            </label>
            <button className="btn btn-ghost" disabled={!serialPort} onClick={() => void connectSerial()}>Connect Serial</button>
            <button className="btn btn-ghost" onClick={() => void monitorApi.disconnectImu().then(setImu)}>Disconnect</button>
          </div>
        </section>
      </div>

      <section className="card-flat">
        <h2>Troubleshooting</h2>
        <ul className="plain-list">
          <li>macOS mic permission must allow Terminal / VS Code / Cursor for audio capture.</li>
          <li>Phantom power must stay OFF for passive contact pickups.</li>
          <li>UNO Q Serial from App Lab may not appear as <code>/dev/cu.*</code> — use the Linux TCP streamer.</li>
          <li>Stale IMU means samples stopped arriving (&gt;1.5 s). Check Wi‑Fi / cable / streamer.</li>
          <li>Demo Mode is available from the sidebar when hardware is unavailable.</li>
        </ul>
      </section>
    </div>
  );
}
