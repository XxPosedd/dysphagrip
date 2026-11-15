import { useCallback, useEffect, useRef, useState } from "react";
import { statusClip } from "../lib/api";
import { VOICE } from "../lib/voicePhrases";

export function useRecordingVoice() {
  const [enabled, setEnabledState] = useState(true);
  const [provider, setProvider] = useState("");
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const enabledRef = useRef(true);
  const context = useRef<AudioContext | null>(null);
  const previewTicket = useRef(0);
  const previewSource = useRef<AudioBufferSourceNode | null>(null);
  const queue = useRef(Promise.resolve());

  const unlock = useCallback(async () => {
    context.current ??= new AudioContext();
    await context.current.resume();
  }, []);

  const cancelPreview = useCallback(() => {
    ++previewTicket.current;
    previewSource.current?.stop();
    previewSource.current = null;
    setPreviewing(false);
  }, []);

  const play = useCallback(async (message: string, previewId?: number) => {
    const wanted = () => previewId === undefined ? enabledRef.current : previewTicket.current === previewId;
    const active = context.current;
    if (!active || !wanted()) return;
    const { blob, provider: sourceName } = await statusClip(message);
    const decoded = await active.decodeAudioData(await blob.arrayBuffer());
    if (!wanted()) return;
    if (active.state !== "running") throw new Error("Browser audio is unavailable.");
    const source = active.createBufferSource();
    source.buffer = decoded;
    source.connect(active.destination);
    if (previewId !== undefined) previewSource.current = source;
    setProvider(sourceName === "elevenlabs" ? "ElevenLabs" : sourceName === "macos" ? "macOS" : "");
    setError("");
    await new Promise<void>(resolve => {
      source.onended = () => {
        source.disconnect();
        if (previewSource.current === source) previewSource.current = null;
        resolve();
      };
      source.start();
    });
  }, []);

  const preview = useCallback(async () => {
    const id = ++previewTicket.current;
    setPreviewing(true);
    setError("");
    try {
      await unlock();
      await play(VOICE.recordingStarted, id);
      await play(VOICE.recordingStopped, id);
    } catch {
      if (id === previewTicket.current) setError("Voice preview could not play.");
    } finally {
      if (id === previewTicket.current) setPreviewing(false);
    }
  }, [play, unlock]);

  const prepare = useCallback(() => {
    cancelPreview();
    if (enabledRef.current) void unlock().catch(() => setError("Audio playback is unavailable in this browser."));
  }, [cancelPreview, unlock]);

  const announce = useCallback((message: string) => {
    if (enabledRef.current) queue.current = queue.current.then(() => play(message))
      .catch(() => setError("The recording announcement could not play."));
  }, [play]);

  useEffect(() => () => {
    ++previewTicket.current;
    previewSource.current?.stop();
    if (context.current) void context.current.close();
  }, []);

  const setEnabled = (value: boolean) => {
    enabledRef.current = value;
    setEnabledState(value);
  };
  return { enabled, provider, error, previewing, setEnabled, preview, prepare, announce };
}
