import { useCallback, useEffect, useRef, useState } from "react";
import { audioApi, ApiError } from "../lib/api";
import { audioWsUrl } from "../lib/config";
import { AudioStream, type ConnectionState } from "../lib/stream";
import type { AudioDevice, AudioFrame, AudioStatus, MotionFrame, MotionStatus, SerialPortInfo } from "../lib/types";

export type FrameListener = (f: AudioFrame) => void;
export type MotionListener = (f: MotionFrame) => void;

/**
 * Connection to the Python audio service.
 * Canvases subscribe to every frame via `subscribe` (no React re-render per frame);
 * `latest` is a throttled copy (~8 Hz) for numeric panels.
 */
export function useAudioService() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [um2Candidate, setUm2Candidate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<AudioFrame | null>(null);
  const [busy, setBusy] = useState(false);
  const [motion, setMotion] = useState<MotionStatus | null>(null);
  const [motionLatest, setMotionLatest] = useState<MotionFrame | null>(null);
  const [motionPorts, setMotionPorts] = useState<SerialPortInfo[]>([]);
  const [motionError, setMotionError] = useState<string | null>(null);
  const motionListeners = useRef(new Set<MotionListener>());
  const lastMotionUi = useRef(0);

  const listeners = useRef(new Set<FrameListener>());
  const lastUiUpdate = useRef(0);

  const subscribe = useCallback((fn: FrameListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const subscribeMotion = useCallback((fn: MotionListener) => {
    motionListeners.current.add(fn);
    return () => void motionListeners.current.delete(fn);
  }, []);

  const refreshMotionPorts = useCallback(async () => {
    try {
      setMotionPorts((await audioApi.motionPorts()).ports);
    } catch {
      setMotionPorts([]);
    }
  }, []);

  const startMotion = useCallback(async (source: string) => {
    setMotionError(null);
    try {
      setMotion(await audioApi.motionStart(source));
    } catch (e) {
      setMotionError((e as Error).message);
    }
  }, []);

  const stopMotion = useCallback(async () => {
    try {
      setMotion(await audioApi.motionStop());
      setMotionLatest(null);
    } catch (e) {
      setMotionError((e as Error).message);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const r = await audioApi.devices();
      setDevices(r.devices);
      setUm2Candidate(r.um2_candidate);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0
        ? "Audio service is not running. Start it with: python -m dysphagrip_audio serve"
        : `Could not list audio devices: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    const stream = new AudioStream(audioWsUrl(), {
      onConnection: (s) => {
        setConnection(s);
        if (s === "open") {
          setError(null);
          void refreshDevices();
          void refreshMotionPorts();
        }
      },
      onStatus: (s) => {
        setStatus(s);
        if (!s.running) setLatest(null);
        if (s.last_error) setError(s.last_error);
      },
      onError: (m) => setError(m),
      onMotionStatus: (s) => {
        setMotion(s);
        if (!s.running) setMotionLatest(null);
      },
      onMotionFrame: (f) => {
        motionListeners.current.forEach((fn) => fn(f));
        const now = performance.now();
        if (now - lastMotionUi.current > 120) {
          lastMotionUi.current = now;
          setMotionLatest(f);
        }
      },
      onFrame: (f) => {
        listeners.current.forEach((fn) => fn(f));
        const now = performance.now();
        if (now - lastUiUpdate.current > 120) {
          lastUiUpdate.current = now;
          setLatest(f);
        }
      },
    });
    stream.connect();
    return () => stream.close();
  }, [refreshDevices, refreshMotionPorts]);

  // Self-heal: if connected but the device list is empty (e.g. the first request raced the
  // service start-up), retry every 3 s until devices appear.
  useEffect(() => {
    if (connection !== "open" || devices.length) return;
    const id = setInterval(() => void refreshDevices(), 3000);
    return () => clearInterval(id);
  }, [connection, devices.length, refreshDevices]);

  const start = useCallback(async (device: number | null, channel: number) => {
    setBusy(true);
    setError(null);
    try {
      const s = await audioApi.start(device, channel);
      setStatus(s);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await audioApi.stop());
      setLatest(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    connection, status, devices, um2Candidate, error, latest, busy, subscribe, refreshDevices, start, stop,
    motion, motionLatest, motionPorts, motionError, subscribeMotion, refreshMotionPorts, startMotion, stopMotion,
  };
}

export type AudioService = ReturnType<typeof useAudioService>;
