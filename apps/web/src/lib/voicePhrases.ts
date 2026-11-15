// Status phrases the dashboard announces. They must match the server allowlist
// (server/src/voice/phrases.ts) exactly; a contract test enforces this.
export const VOICE = {
  recordingStarted: "Recording started.",
  recordingStopped: "Recording stopped.",
  sessionSaved: "Session saved successfully.",
  sessionNotSaved: "Session could not be saved.",
  signalDetected: "Audio signal detected.",
  inputStopped: "Audio input stopped.",
  noSignal: "No audio signal. Check the sensor connection.",
  clipping: "Audio input is clipping. Reduce the gain.",
  mainsHum: "Electrical hum detected. Check the cable and grounding.",
  movementInterference: "Movement interference detected.",
  motionConnected: "Motion sensor connected.",
  motionDisconnected: "Motion sensor disconnected.",
  voiceReady: "Voice feedback is ready.",
} as const;

export type VoiceText = (typeof VOICE)[keyof typeof VOICE];
