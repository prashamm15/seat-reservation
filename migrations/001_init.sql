-- 001_init.sql
-- Idempotent schema migration. Safe to run multiple times.
-- Applied at startup inside a pg_advisory_lock (see src/db.js).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price_paise bigint NOT NULL CHECK (price_paise >= 0),
  per_user_limit int NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  hold_ttl_seconds int NOT NULL DEFAULT 120,
  total_seats int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  show_id uuid NOT NULL REFERENCES shows(id),
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'held', 'confirmed')),
  user_id text NULL,
  reservation_id uuid NULL,
  held_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, label)
);

CREATE INDEX IF NOT EXISTS idx_seats_reservation_id ON seats (reservation_id);
CREATE INDEX IF NOT EXISTS idx_seats_show_user ON seats (show_id, user_id) WHERE status <> 'available';
CREATE INDEX IF NOT EXISTS idx_seats_held_until ON seats (held_until) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL REFERENCES shows(id),
  user_id text NOT NULL,
  seats text[] NOT NULL,
  amount_paise bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'held', 'confirmed', 'cancelled', 'expired')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_reservations_show_user ON reservations (show_id, user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status_expires ON reservations (status, expires_at);
