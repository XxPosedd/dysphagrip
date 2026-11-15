-- DysphaGrip schema (Neon Postgres). Idempotent: safe to run repeatedly via `npm run db:migrate --prefix server`.
--
-- Privacy: no names, contact details or free-text health information are collected by the app.
-- Labels and marker notes are length-limited and should contain only neutral session descriptions.
-- Raw audio is never stored; only derived signal summaries.

CREATE TABLE IF NOT EXISTS recording_sessions (
  id                       UUID PRIMARY KEY,
  label                    TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  started_at               TIMESTAMPTZ NOT NULL,
  ended_at                 TIMESTAMPTZ NOT NULL,
  duration_ms              INTEGER NOT NULL CHECK (duration_ms >= 0),
  audio_source             TEXT NOT NULL CHECK (char_length(audio_source) <= 200),
  audio_source_kind        TEXT NOT NULL CHECK (audio_source_kind IN ('device', 'file', 'unknown')),
  frames                   INTEGER NOT NULL DEFAULT 0 CHECK (frames >= 0),
  dropped_samples          BIGINT NOT NULL DEFAULT 0 CHECK (dropped_samples >= 0),
  activity_ms              INTEGER NOT NULL DEFAULT 0 CHECK (activity_ms >= 0),
  activity_segments        INTEGER NOT NULL DEFAULT 0 CHECK (activity_segments >= 0),
  manual_markers           INTEGER NOT NULL DEFAULT 0 CHECK (manual_markers >= 0),
  median_noise_floor_dbfs  REAL,
  max_rms_dbfs             REAL,
  motion_connected         BOOLEAN NOT NULL DEFAULT FALSE,
  app_version              TEXT NOT NULL DEFAULT '0.1.0',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS recording_sessions_started_at_idx ON recording_sessions (started_at DESC);

-- Experimental event markers. "audio_activity" = energy above the noise floor (NOT a swallow detection).
CREATE TABLE IF NOT EXISTS session_markers (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('manual', 'audio_activity', 'quality', 'movement_interference')),
  t_ms         INTEGER NOT NULL CHECK (t_ms >= 0),
  duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  label        TEXT NOT NULL CHECK (char_length(label) <= 80),
  note         TEXT CHECK (note IS NULL OR char_length(note) <= 280)
);

CREATE INDEX IF NOT EXISTS session_markers_session_idx ON session_markers (session_id, t_ms);

-- Signal-quality summary: time spent in each quality state per session.
CREATE TABLE IF NOT EXISTS session_quality (
  session_id   UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  quality      TEXT NOT NULL CHECK (quality IN ('ok', 'no_signal', 'clipping', 'mains_hum')),
  duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0),
  PRIMARY KEY (session_id, quality)
);

-- Public-interest resources (Bright Data / MedlinePlus). Source URL, publisher, licence and retrieval time are mandatory
-- for display; see server/src/resources/sources.ts for how each source was vetted.
CREATE TABLE IF NOT EXISTS public_resources (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS summary             TEXT;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS publisher           TEXT;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS language            TEXT NOT NULL DEFAULT 'en';
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS collected_via       TEXT;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS license_note        TEXT;
ALTER TABLE public_resources ADD COLUMN IF NOT EXISTS source_last_updated TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS public_resources_source_url_key ON public_resources (source_url);
