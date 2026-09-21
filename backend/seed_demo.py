"""One-off demo-data seeder for local/offline testing of the prototype.

Not part of the deployed app (nothing imports this from app.py/api.py) --
run it by hand after a fresh init_db() to populate a few realistic accounts
plus enough leave requests / duty preferences to actually exercise the
AI-scheduling workflow, so the prototype isn't staring back at an empty
grid or an empty preferences screen the first time it's opened.

Usage:  cd backend && python3 seed_demo.py
Safe to re-run -- skips any username that already exists.
"""
import datetime
import json
import sys

from auth import hash_password
from db import get_db, init_db

DEMO_PASSWORD = "demo12345"  # placeholder only -- change every seeded password before any real deployment


def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


def demo_month():
    return datetime.date.today().strftime("%Y-%m")


DEVELOPER = {"username": "developer", "displayName": "Site Developer", "role": "developer"}

# A small, plausible roster across all 5 units -- one Head of Unit
# (Professor), one Fellow, and one or two Postgraduates each.
# is_coordinator is deliberately NOT always the Head of Unit -- the
# developer assigns it to whichever specific person runs scheduling for a
# unit (see api.py's is_coordinator column), so ent1 demos "HoU is also the
# coordinator" and ent2 demos "coordinator is someone else entirely".
UNIT_MEMBERS = {
    "ent1": [
        {"username": "prof.rao", "displayName": "Dr. Anand Rao", "role": "professor", "designation": "Professor", "onCallRank": "Not on call rotation", "post": "Head of Unit", "isCoordinator": True},
        {"username": "fellow.iyer", "displayName": "Dr. Meera Iyer", "role": "fellow", "onCallRank": "1st on call", "post": "Other"},
        {"username": "pg.sharma", "displayName": "Dr. Rohan Sharma", "role": "postgraduate", "onCallRank": "2nd on call", "post": "Other"},
    ],
    "ent2": [
        {"username": "prof.nair", "displayName": "Dr. Lakshmi Nair", "role": "professor", "designation": "Senior Professor", "onCallRank": "Not on call rotation", "post": "Head of Unit"},
        {"username": "pg.verma", "displayName": "Dr. Aditya Verma", "role": "postgraduate", "onCallRank": "1st on call", "post": "Other", "isCoordinator": True},
    ],
    "ent3": [
        {"username": "prof.khan", "displayName": "Dr. Imran Khan", "role": "professor", "designation": "Associate Professor", "onCallRank": "Not on call rotation", "post": "Head of Unit"},
        {"username": "fellow.das", "displayName": "Dr. Priya Das", "role": "fellow", "onCallRank": "1st on call", "post": "Other"},
        {"username": "pg.kulkarni", "displayName": "Dr. Sanjay Kulkarni", "role": "postgraduate", "onCallRank": "2nd on call", "post": "Other"},
    ],
    "ent4": [
        {"username": "prof.gupta", "displayName": "Dr. Neha Gupta", "role": "professor", "designation": "Assistant Professor", "onCallRank": "Not on call rotation", "post": "Head of Unit"},
        {"username": "pg.patel", "displayName": "Dr. Kavya Patel", "role": "postgraduate", "onCallRank": "1st on call", "post": "Other"},
    ],
    "ent5": [
        {"username": "prof.reddy", "displayName": "Dr. Srinivas Reddy", "role": "professor", "designation": "Professor", "onCallRank": "Not on call rotation", "post": "Head of Unit"},
        {"username": "fellow.menon", "displayName": "Dr. Arjun Menon", "role": "fellow", "onCallRank": "1st on call", "post": "Other"},
        {"username": "pg.singh", "displayName": "Dr. Ishaan Singh", "role": "postgraduate", "onCallRank": "2nd on call", "post": "Other"},
    ],
}

# A few sample leave requests this month, keyed by (unit, username, day, day, type_key)
SAMPLE_LEAVE = [
    ("ent1", "fellow.iyer", 5, 7, "casual_leave"),
    ("ent1", "pg.sharma", 12, 12, "sick_leave"),
    ("ent2", "pg.verma", 3, 4, "academic_leave"),
]

# One duty_preferences row per (unit, username) for this month.
SAMPLE_DUTY_PREFS = [
    ("ent1", "pg.sharma", {"preferredTypes": ["day_duty"], "avoidTypes": ["night_duty"], "maxConsecutiveOncalls": 2, "notes": "Would prefer not to be on call on weekends this month."}),
    ("ent1", "fellow.iyer", {"preferredTypes": ["on_call"], "avoidTypes": [], "maxConsecutiveOncalls": 3, "notes": ""}),
    ("ent2", "prof.nair", {"preferredTypes": [], "avoidTypes": ["night_duty"], "maxConsecutiveOncalls": None, "notes": "Clinic commitments most afternoons."}),
]

# ent1 is seeded as already-approved (a finished, published schedule to
# look at immediately) using a plain deterministic fill -- NOT a real AI
# call, since this seeder has no API key context. ent2-5 are left with no
# schedule_runs row at all, so logging in as their coordinator and hitting
# "Generate" is the first thing to try.
SAMPLE_APPROVED_ENTRIES = {
    "ent1": [
        ("pg.sharma", 1, "day_duty"), ("pg.sharma", 2, "day_duty"), ("pg.sharma", 3, "on_call"),
        ("fellow.iyer", 1, "night_duty"), ("fellow.iyer", 2, "post_call"),
        ("prof.rao", 1, "off_day"),
    ],
}


def user_exists(db, username):
    return db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone() is not None


def insert_user(db, username, display_name, role, unit=None, designation=None, on_call_rank=None, post=None, is_coordinator=False):
    if user_exists(db, username):
        print(f"  skip (exists): {username}")
        return
    db.execute(
        "INSERT INTO users (username, password_hash, role, display_name, designation, unit, on_call_rank, post, is_coordinator, active, approval_status, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,1,'approved',?)",
        (username, hash_password(DEMO_PASSWORD), role, display_name, designation, unit, on_call_rank, post, 1 if is_coordinator else 0, now_iso()),
    )
    print(f"  created: {username} ({role}, {unit or '-'}{', coordinator' if is_coordinator else ''})")


def main():
    init_db()
    db = get_db()

    print("Developer account:")
    insert_user(db, DEVELOPER["username"], DEVELOPER["displayName"], "developer")

    print("Unit members:")
    for unit, members in UNIT_MEMBERS.items():
        for m in members:
            insert_user(
                db, m["username"], m["displayName"], m["role"], unit=unit,
                designation=m.get("designation"), on_call_rank=m.get("onCallRank"),
                post=m.get("post"), is_coordinator=m.get("isCoordinator", False),
            )
    db.commit()

    month = demo_month()

    print("Sample leave requests:")
    for unit, username, start_day, end_day, type_key in SAMPLE_LEAVE:
        start_date, end_date = f"{month}-{start_day:02d}", f"{month}-{end_day:02d}"
        existing = db.execute(
            "SELECT 1 FROM leave_requests WHERE username=? AND start_date=? AND end_date=?",
            (username, start_date, end_date),
        ).fetchone()
        if existing:
            print(f"  skip (exists): {username} {start_date}..{end_date}")
            continue
        db.execute(
            "INSERT INTO leave_requests (username, start_date, end_date, type_key, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (username, start_date, end_date, type_key, None, now_iso(), now_iso()),
        )
        print(f"  set: {username} {start_date}..{end_date} -> {type_key}")
    db.commit()

    print("Sample duty preferences:")
    for unit, username, prefs in SAMPLE_DUTY_PREFS:
        existing = db.execute("SELECT 1 FROM duty_preferences WHERE username=? AND month=?", (username, month)).fetchone()
        if existing:
            print(f"  skip (exists): {username} {month}")
            continue
        db.execute(
            "INSERT INTO duty_preferences (username, month, preferred_types, avoid_types, preferred_dates, avoid_dates, max_consecutive_oncalls, notes, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (username, month, json.dumps(prefs.get("preferredTypes", [])), json.dumps(prefs.get("avoidTypes", [])),
             json.dumps([]), json.dumps([]), prefs.get("maxConsecutiveOncalls"), prefs.get("notes") or None, now_iso()),
        )
        print(f"  set: {username} {month}")
    db.commit()

    print("Sample approved schedule (ent1 only, plain fill -- not a real AI call):")
    for unit, rows in SAMPLE_APPROVED_ENTRIES.items():
        existing_run = db.execute("SELECT 1 FROM schedule_runs WHERE unit=? AND month=?", (unit, month)).fetchone()
        if existing_run:
            print(f"  skip (exists): {unit} {month} schedule_runs row")
            continue
        for username, day, type_key in rows:
            date_str = f"{month}-{day:02d}"
            db.execute(
                "INSERT INTO roster_entries (username, entry_date, type_key, note, updated_at, updated_by) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(username, entry_date) DO NOTHING",
                (username, date_str, type_key, None, now_iso(), "developer"),
            )
        db.execute(
            "INSERT INTO schedule_runs (unit, month, status, redo_count, ai_notes, conflicts_json, used_placeholder, generated_at, generated_by, approved_at, approved_by) "
            "VALUES (?,?,'approved',0,?,?,1,?,?,?,?)",
            (unit, month, "Seed data for the demo -- not a real generation.", "[]", now_iso(), "developer", now_iso(), "developer"),
        )
        print(f"  approved: {unit} {month}")
    db.commit()

    print(f"\nDone. Demo login -- developer / {DEMO_PASSWORD} (change this before any real deployment).")
    print("Every seeded account shares that same placeholder password.")
    print("prof.rao (ent1) and pg.verma (ent2) are seeded as coordinators -- log in as either and")
    print("visit Generate Schedule. ent1 already has an approved demo schedule; try Generate on ent2-5.")
    print("No ANTHROPIC_API_KEY is set by this seeder -- Generate will use the labeled placeholder rotation")
    print("until you set one in the environment.")


if __name__ == "__main__":
    sys.exit(main())
