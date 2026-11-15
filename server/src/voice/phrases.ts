/**
 * The ONLY sentences the voice endpoint will synthesise.
 *
 * Why an allowlist:
 *  - Cost/abuse: a public TTS endpoint that speaks arbitrary text would let anyone spend the ElevenLabs quota.
 *  - Safety: every phrase is operational status feedback about the recording. None of them is medical advice
 *    or a clinical finding (no "safe swallow", "aspiration", diagnosis or intervention wording).
 *
 * The dashboard's copy lives in apps/web/src/lib/voicePhrases.ts; a contract test keeps the two in sync.
 */
export const VOICE_PHRASES = [
  // Session lifecycle
  "Recording started.",
  "Recording stopped.",
  "Session saved successfully.",
  "Session could not be saved.",
  // Audio signal state
  "Audio signal detected.",
  "Audio input stopped.",
  "No audio signal. Check the sensor connection.",
  "Audio input is clipping. Reduce the gain.",
  "Electrical hum detected. Check the cable and grounding.",
  // Motion (used once the MPU-6050 stream exists, Phase 3/4)
  "Movement interference detected.",
  "Motion sensor connected.",
  "Motion sensor disconnected.",
  // Settings check
  "Voice feedback is ready.",
] as const;

export type VoicePhrase = (typeof VOICE_PHRASES)[number];

const ALLOWED = new Set<string>(VOICE_PHRASES);

export function isAllowedPhrase(text: string): text is VoicePhrase {
  return ALLOWED.has(text);
}
