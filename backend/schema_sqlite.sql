-- ENT Duty Roster -- SQLite schema (real backend).
-- Applied automatically on first run by db.py. Same rationale as the ENT
-- Surgical Logbook project this was split off from: one file, on one
-- persistent disk, is enough for a single department's roster. See that
-- project's README for the notes on moving to Postgres later if ever needed.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('postgraduate','fellow','professor','developer')),
  display_name    TEXT NOT NULL,
  -- Only meaningful when role='professor': Assistant/Associate/Professor/
  -- Senior Professor (admin-editable list, see config.designations).
  designation     TEXT,
  -- Fixed home unit for the roster -- unlike the Logbook project, this app
  -- doesn't track rotating postings; a person's roster lives under whatever
  -- unit their account currently points at. ENT 1-5 by default (see
  -- config.units) but not hard-coded -- the developer's unit master list
  -- can add or remove units the same way the Logbook's can.
  unit            TEXT,
  -- On-call priority within the unit ("1st on call", "2nd on call", ...) --
  -- admin-editable list, see config.onCallRanks. Purely informational/
  -- sort-order, not itself a grid cell value.
  on_call_rank    TEXT,
  -- "Head of Unit" or "Other" (config.posts). Head of Unit now DOES grant
  -- one extra right (added for the AI-scheduling workflow): editing
  -- role/designation/on_call_rank for other users in their OWN unit only.
  -- It grants nothing else -- not unit, not post, not is_coordinator, not
  -- account creation/deletion. See api.py can_edit_profile_fields().
  post            TEXT,
  -- Sole gate on /api/schedule/generate, /redo, /approve for this user's
  -- unit. Not tied to role/post/designation -- the developer flips this
  -- flag on whichever specific person is meant to run scheduling for a
  -- unit (see users PATCH in api.py, developer-only to set).
  is_coordinator  INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved')),
  created_at      TEXT NOT NULL
);

-- One row per person per calendar day they've actually been assigned
-- something -- a blank/unassigned day simply has no row (sparse, not a
-- fixed 31-column table). type_key points at one of config.shiftLeaveTypes'
-- keys, resolved app-side rather than a SQL foreign key (config is a JSON
-- blob, like the Logbook's dropdown lists) -- deleting a type from the
-- master list intentionally leaves already-logged rows alone (their label/
-- color just falls back to "unrecognized").
--
-- v2 change: nobody writes these directly anymore. They are ONLY written
-- by POST /api/schedule/generate (and its redo path), which deletes and
-- re-inserts every row for one unit+month at a time. There is no manual
-- cell-edit endpoint left -- see schedule_runs below for the review/
-- approve state that gates whether a unit's members can see these rows
-- at all (draft = coordinator/developer only, approved = whole unit).
CREATE TABLE IF NOT EXISTS roster_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  entry_date      TEXT NOT NULL,
  type_key        TEXT NOT NULL,
  note            TEXT,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  UNIQUE(username, entry_date)
);
CREATE INDEX IF NOT EXISTS idx_roster_username ON roster_entries(username);
CREATE INDEX IF NOT EXISTS idx_roster_date ON roster_entries(entry_date);

-- Single-row table holding every editable dropdown (shift/leave types,
-- units, designations, on-call ranks, posts) as one JSON blob -- identical
-- pattern to the Logbook project's config table, and the whole reason a
-- "Manage Lists" screen can add/edit/delete entries without a migration.
CREATE TABLE IF NOT EXISTS config (
  id      TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);

-- Server-side sessions: the cookie only ever carries a random opaque token,
-- never any user data.
CREATE TABLE IF NOT EXISTS sessions (
  token           TEXT PRIMARY KEY,
  username        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- Failed-login tracking for rate limiting (per username+IP).
CREATE TABLE IF NOT EXISTS login_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,
  attempted_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(key, attempted_at);

-- One row per leave request (a date range, not a single day) -- the input
-- side of the AI-generation workflow. type_key must resolve to a
-- config.shiftLeaveTypes entry with category='leave'. Not itself an
-- approval workflow: submitting one doesn't touch the roster -- it's just
-- a constraint the schedule generator is told to respect (and validates
-- against afterwards).
CREATE TABLE IF NOT EXISTS leave_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  type_key        TEXT NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_username ON leave_requests(username);

-- One row per person per calendar month: everything else that feeds the
-- generator besides formal leave -- shift-type likes/dislikes, specific
-- dates they'd rather work or avoid, a cap on consecutive on-calls, and a
-- freeform note (the AI prompt includes this verbatim). Upsert on
-- (username, month).
CREATE TABLE IF NOT EXISTS duty_preferences (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  username                TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  month                   TEXT NOT NULL,
  preferred_types         TEXT,
  avoid_types             TEXT,
  preferred_dates         TEXT,
  avoid_dates             TEXT,
  max_consecutive_oncalls INTEGER,
  notes                   TEXT,
  updated_at              TEXT NOT NULL,
  UNIQUE(username, month)
);
CREATE INDEX IF NOT EXISTS idx_dutyprefs_username ON duty_preferences(username);

-- One row per unit+month: the review/approve state around an AI-generated
-- schedule. status='none' until the first generate call; 'draft' after
-- generate/redo (only the unit's coordinator and the developer can see the
-- roster_entries rows for that unit+month while draft); 'approved' once
-- the coordinator approves it (visible to the whole unit, still read-only
-- -- there is no manual cell edit, only another generate/redo cycle).
CREATE TABLE IF NOT EXISTS schedule_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  unit                TEXT NOT NULL,
  month               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','draft','approved')),
  redo_count          INTEGER NOT NULL DEFAULT 0,
  extra_instructions  TEXT,
  ai_notes            TEXT,
  conflicts_json      TEXT,
  used_placeholder    INTEGER NOT NULL DEFAULT 0,
  generated_at        TEXT,
  generated_by        TEXT,
  approved_at         TEXT,
  approved_by         TEXT,
  UNIQUE(unit, month)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  requested_at    TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_by     TEXT
);
