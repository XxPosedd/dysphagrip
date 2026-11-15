import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { VoiceText } from "../lib/voicePhrases";

export type VoiceState = "unknown" | "ready" | "not_configured" | "error" | "api_offline";

export interface Announcement {
  id: number;
  text: string;
  /** spoken = played through ElevenLabs; text = shown only (voice off / not configured / failed). */
  delivery: "pending" | "spoken" | "text";
  at: number;
}

export interface VoiceInfo {
  configured: boolean;
  model_id: string | null;
  voice: { id: string; name: string | null } | null;
}

/**
 * Status announcements. Every message is always shown as text (aria-live). When ElevenLabs is
 * configured on the server it is also spoken. The browser's built-in speech synthesis is
 * deliberately NOT used as a silent substitute, so the demo never implies ElevenLabs is
 * working when it isn't.
 */
export function useVoice(enabledInitially = true) {
  const [enabled, setEnabledState] = useState(enabledInitially);
  const [state, setState] = useState<VoiceState>("unknown");
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [log, setLog] = useState<Announcement[]>([]);
  const enabledRef = useRef(enabled);
  const stateRef = useRef(state);
  stateRef.current = state;
  const queue = useRef(Promise.resolve());
  const nextId = useRef(1);
  const recent = useRef(new Map<string, number>());

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
    setEnabledState(v);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const i = await api.voice();
      setInfo(i);
      setState(i.configured ? "ready" : "not_configured");
      setLastError(null);
    } catch {
      setInfo(null);
      setState("api_offline");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const mark = (id: number, delivery: Announcement["delivery"]) =>
    setLog((l) => l.map((a) => (a.id === id ? { ...a, delivery } : a)));

  const play = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      await audio.play(); // may reject if the browser blocks autoplay before any user interaction
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        setTimeout(resolve, 10_000);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  /** Announce a status phrase. Identical phrases within 5 s are collapsed. */
  const announce = useCallback((text: VoiceText, opts: { force?: boolean } = {}) => {
    const now = Date.now();
    if (!opts.force && now - (recent.current.get(text) ?? 0) < 5000) return;
    recent.current.set(text, now);
    const id = nextId.current++;
    const speak = (opts.force || enabledRef.current) && stateRef.current !== "not_configured" && stateRef.current !== "api_offline";
    setLog((l) => [{ id, text, delivery: speak ? "pending" : "text", at: now } as Announcement, ...l].slice(0, 30));
    if (!speak) return;

    queue.current = queue.current.then(async () => {
      try {
        const blob = await api.speak(text);
        await play(blob);
        setState("ready");
        mark(id, "spoken");
      } catch (e) {
        mark(id, "text");
        if (e instanceof ApiError && e.status === 501) { setState("not_configured"); return; }
        const msg = e instanceof DOMException && e.name === "NotAllowedError"
          ? "The browser blocked audio playback. Click anywhere on the page, then try again."
          : (e as Error).message;
        setLastError(msg);
        setState("error");
      }
    });
  }, []);

  return { enabled, setEnabled, state, info, lastError, log, announce, refresh };
}
