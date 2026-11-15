import { useCallback, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

export type VoiceState = "unknown" | "ready" | "not_configured" | "error";

export interface Announcement {
  id: number;
  text: string;
  spoken: boolean;
}

/**
 * Status announcements. Every message is always shown as text (aria-live). It is also
 * spoken through the server's ElevenLabs endpoint when that is configured. The browser's
 * built-in speech synthesis is deliberately NOT used as a silent substitute, so the
 * demo never implies ElevenLabs is working when it isn't.
 */
export function useVoice(enabledInitially = true) {
  const [enabled, setEnabled] = useState(enabledInitially);
  const [state, setState] = useState<VoiceState>("unknown");
  const [log, setLog] = useState<Announcement[]>([]);
  const queue = useRef(Promise.resolve());
  const nextId = useRef(1);
  const lastText = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const announce = useCallback((text: string) => {
    const now = Date.now();
    if (lastText.current.text === text && now - lastText.current.at < 5000) return; // de-duplicate
    lastText.current = { text, at: now };
    const id = nextId.current++;
    setLog((l) => [{ id, text, spoken: false }, ...l].slice(0, 20));
    if (!enabled) return;

    queue.current = queue.current.then(async () => {
      try {
        const blob = await api.speak(text);
        setState("ready");
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        await audio.play().catch(() => undefined);   // autoplay may be blocked before user interaction
        await new Promise<void>((r) => { audio.onended = () => r(); audio.onerror = () => r(); setTimeout(r, 8000); });
        URL.revokeObjectURL(url);
        setLog((l) => l.map((a) => (a.id === id ? { ...a, spoken: true } : a)));
      } catch (e) {
        setState(e instanceof ApiError && e.status === 501 ? "not_configured" : "error");
      }
    });
  }, [enabled]);

  return { enabled, setEnabled, state, log, announce };
}
