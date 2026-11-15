import { useCallback, useEffect, useRef, useState } from "react";
import { liveWsUrl, monitorApi } from "../lib/monitorApi";
import type {
  AppMode,
  CalibrationProgress,
  CandidateEvent,
  ImuFeatures,
  ImuSampleMsg,
  ImuStatus,
  LiveFrameMessage,
  SessionSnapshot,
} from "../lib/monitorTypes";
import type { AudioFrame } from "../lib/types";

export type LiveListener = (msg: LiveFrameMessage) => void;
export type ConnectionState = "connecting" | "open" | "closed";

const MAX_EVENTS = 200;
const MAX_IMU = 120;

export function useMonitor() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [mode, setModeState] = useState<AppMode>("live");
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [latestAudio, setLatestAudio] = useState<AudioFrame | null>(null);
  const [latestImu, setLatestImu] = useState<ImuSampleMsg | null>(null);
  const [imuFeatures, setImuFeatures] = useState<ImuFeatures | null>(null);
  const [imuStatus, setImuStatus] = useState<ImuStatus | null>(null);
  const [events, setEvents] = useState<CandidateEvent[]>([]);
  const [imuHistory, setImuHistory] = useState<ImuSampleMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationProgress | null>(null);
  const [flashEvent, setFlashEvent] = useState<CandidateEvent | null>(null);

  const listeners = useRef(new Set<LiveListener>());
  const lastUi = useRef(0);

  const subscribe = useCallback((fn: LiveListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      setConnection("connecting");
      ws = new WebSocket(liveWsUrl());
      ws.onopen = () => {
        retry = 0;
        setConnection("open");
        setError(null);
        void monitorApi.health().then((h) => {
          setModeState(h.mode);
          setImuStatus(h.imu);
        }).catch(() => undefined);
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const type = msg.type as string;
        if (type === "error") {
          setError(String(msg.message || "Monitor error"));
          return;
        }
        if (type === "hello" || type === "session_state" || type === "mode") {
          if (msg.mode === "live" || msg.mode === "demo") setModeState(msg.mode);
          if (msg.session) setSession(msg.session as SessionSnapshot);
          if (type === "hello" && msg.imu) setImuStatus(msg.imu as ImuStatus);
          return;
        }
        if (type === "calibration") {
          setCalibration(msg as unknown as CalibrationProgress);
          return;
        }
        if (type === "device_health" && msg.imu) {
          setImuStatus(msg.imu as ImuStatus);
          return;
        }
        if (type === "live_frame" || type === "tick") {
          const live = msg as unknown as LiveFrameMessage;
          if (live.session) setSession(live.session);
          if (live.device_health?.imu) setImuStatus(live.device_health.imu);
          if (live.mode) setModeState(live.mode);
          if (live.imu) {
            setLatestImu(live.imu);
            setImuHistory((h) => {
              const next = [...h, live.imu!];
              return next.length > MAX_IMU ? next.slice(-MAX_IMU) : next;
            });
          }
          if (live.imu_features) setImuFeatures(live.imu_features);
          if (live.event) {
            setEvents((e) => {
              const next = [...e, live.event!];
              return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
            });
            setFlashEvent(live.event);
          }
          if (type === "live_frame" && live.audio) {
            listeners.current.forEach((fn) => fn(live));
            const now = performance.now();
            if (now - lastUi.current > 100) {
              lastUi.current = now;
              setLatestAudio(live.audio);
              if (live.session?.calibration) setCalibration(live.session.calibration);
            }
          }
        }
      };
      ws.onclose = () => {
        setConnection("closed");
        if (closed) return;
        const delay = Math.min(5000, 500 * 2 ** retry++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (!flashEvent) return;
    const id = setTimeout(() => setFlashEvent(null), 3500);
    return () => clearTimeout(id);
  }, [flashEvent]);

  const setMode = useCallback(async (m: AppMode) => {
    setBusy(true);
    setError(null);
    try {
      await monitorApi.setMode(m);
      setModeState(m);
      setEvents([]);
      setImuHistory([]);
      setLatestAudio(null);
      setLatestImu(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const startMonitoring = useCallback(async (label?: string) => {
    setBusy(true);
    setError(null);
    try {
      setEvents([]);
      await monitorApi.startSession(label);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const stopMonitoring = useCallback(async () => {
    setBusy(true);
    try {
      return await monitorApi.stopSession();
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const resetSession = useCallback(async () => {
    setBusy(true);
    try {
      await monitorApi.resetSession();
      setEvents([]);
      setImuHistory([]);
      setLatestAudio(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const calibrate = useCallback(async () => {
    setBusy(true);
    try {
      const prog = await monitorApi.startCalibration();
      setCalibration(prog);
      if ((prog as { error?: string }).error) setError((prog as { error?: string }).error || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    connection, mode, session, latestAudio, latestImu, imuFeatures, imuStatus,
    events, imuHistory, error, busy, calibration, flashEvent,
    subscribe, setMode, startMonitoring, stopMonitoring, resetSession, calibrate, setError,
  };
}

export type MonitorService = ReturnType<typeof useMonitor>;
