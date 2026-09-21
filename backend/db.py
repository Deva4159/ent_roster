"""SQLite connection + schema bootstrap + default config seed.

Same shape as the ENT Surgical Logbook project's db.py: one connection per
thread, WAL journal mode, a schema file applied once, then a series of
additive migration functions gated on their own "already applied?" check --
never a single early return, so every migration layers correctly no matter
which ones a given pre-existing database already has.
"""
import json
import os
import sqlite3
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DUTYROSTER_DB_PATH", os.path.join(BASE_DIR, "..", "data", "dutyroster.db"))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema_sqlite.sql")

_local = threading.local()


def get_db():
    if not hasattr(_local, "conn"):
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        _local.conn = conn
    return _local.conn


# Starter set, deliberately generic -- edited from the developer's "Manage
# Lists" screen (Shift & Leave Types) rather than hard-coded once the real
# department list is known. `category` drives which section of the grid
# legend a type shows under and gives the "off day / on leave" filter a
# stable thing to match on; `color` is a CSS custom-property name already
# defined in styles.css so every chip stays theme-aware in dark mode too.
DEFAULT_SHIFT_LEAVE_TYPES = [
    {"key": "day_duty", "label": "Day Duty", "category": "shift", "color": "teal"},
    {"key": "night_duty", "label": "Night Duty", "category": "shift", "color": "violet"},
    {"key": "on_call", "label": "On Call", "category": "oncall", "color": "amber"},
    {"key": "post_call", "label": "Post-Call", "category": "off", "color": "grey"},
    {"key": "off_day", "label": "Off Day", "category": "off", "color": "green"},
    {"key": "casual_leave", "label": "Casual Leave", "category": "leave", "color": "red"},
    {"key": "sick_leave", "label": "Sick Leave", "category": "leave", "color": "red"},
    {"key": "academic_leave", "label": "Academic Leave", "category": "leave", "color": "blue"},
]

DEFAULT_UNITS = [
    {"key": "ent1", "shortForm": "ENT 1", "fullName": "Oto-laryngology Unit 1"},
    {"key": "ent2", "shortForm": "ENT 2", "fullName": "Oto-laryngology Unit 2"},
    {"key": "ent3", "shortForm": "ENT 3", "fullName": "Oto-laryngology Unit 3"},
    {"key": "ent4", "shortForm": "ENT 4", "fullName": "Oto-laryngology Unit 4"},
    {"key": "ent5", "shortForm": "ENT 5", "fullName": "Oto-laryngology Unit 5"},
]

DEFAULT_DESIGNATIONS = ["Assistant Professor", "Associate Professor", "Professor", "Senior Professor"]

DEFAULT_ON_CALL_RANKS = ["1st on call", "2nd on call", "3rd on call", "4th on call", "5th on call", "Not on call rotation"]

DEFAULT_POSTS = ["Head of Unit", "Other"]

DEFAULT_CONFIG = {
    "shiftLeaveTypes": DEFAULT_SHIFT_LEAVE_TYPES,
    "units": DEFAULT_UNITS,
    "designations": DEFAULT_DESIGNATIONS,
    "onCallRanks": DEFAULT_ON_CALL_RANKS,
    "posts": DEFAULT_POSTS,
}


def _existing_tables(conn):
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {r["name"] for r in rows}


def seed_config(conn):
    row = conn.execute("SELECT 1 FROM config WHERE id = 'lists'").fetchone()
    if row:
        return
    conn.execute("INSERT INTO config (id, data) VALUES ('lists', ?)", (json.dumps(DEFAULT_CONFIG),))
    conn.commit()


def migrate_add_coordinator_column(conn):
    """CREATE TABLE IF NOT EXISTS never adds a column to an existing table --
    only relevant for a database created before the AI-scheduling workflow
    was added (a fresh dutyroster.db already gets the column from the
    schema file above)."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "is_coordinator" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_coordinator INTEGER NOT NULL DEFAULT 0")
        conn.commit()


def init_db():
    conn = get_db()
    with open(SCHEMA_PATH, "r") as f:
        conn.executescript(f.read())
    conn.commit()
    migrate_add_coordinator_column(conn)
    seed_config(conn)
