CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence integer PRIMARY KEY AUTOINCREMENT,
  id text NOT NULL UNIQUE,
  project_id text NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL,
  actor text NOT NULL,
  target text NOT NULL,
  payload text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project_sequence
  ON events(project_id, sequence);

CREATE INDEX IF NOT EXISTS idx_events_project_type
  ON events(project_id, type);

CREATE INDEX IF NOT EXISTS idx_events_created_at
  ON events(created_at);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection_name text PRIMARY KEY,
  event_id text NOT NULL,
  updated_at text NOT NULL
);
