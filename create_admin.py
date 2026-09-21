"""One-off provisioning script for a REAL developer (master-control) account.

Unlike seed_demo.py (placeholder demo data, one shared throwaway password,
explicitly not for production), this creates or resets exactly ONE real
developer account from environment variables. Deliberately takes no
command-line arguments and hardcodes nothing -- a real password belongs in
neither this file nor anywhere else in source control, and command-line
arguments leak into shell history; environment variables set inline on the
invocation don't.

Usage (local):
  cd backend
  ADMIN_USERNAME=youruser ADMIN_PASSWORD='yourpassword' python3 create_admin.py

Usage (Render): open a shell for the web service (same persistent disk as
the running app -- DUTYROSTER_DB_PATH should already point there) and run
the same command.

Safe to re-run: if the username already exists, this resets its password
and makes sure it's an active, approved developer account rather than
creating a duplicate.
"""
import datetime
import os
import sys

from auth import hash_password
from db import get_db, init_db


def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


def main():
    username = os.environ.get("ADMIN_USERNAME")
    password = os.environ.get("ADMIN_PASSWORD")
    display_name = os.environ.get("ADMIN_DISPLAY_NAME") or username

    if not username or not password:
        print(
            "Set ADMIN_USERNAME and ADMIN_PASSWORD as environment variables on the command itself "
            "(not typed into a prompt, not hardcoded in this file), e.g.:\n\n"
            "  ADMIN_USERNAME=youruser ADMIN_PASSWORD='yourpassword' python3 create_admin.py\n"
        )
        return 1
    if len(password) < 8:
        print("Password must be at least 8 characters.")
        return 1

    username = username.strip().lower()
    init_db()
    db = get_db()
    existing = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        db.execute(
            "UPDATE users SET password_hash=?, role='developer', display_name=?, unit=NULL, "
            "designation=NULL, on_call_rank=NULL, post=NULL, is_coordinator=0, active=1, approval_status='approved' "
            "WHERE username=?",
            (hash_password(password), display_name, username),
        )
        db.commit()
        print(f"Updated existing account '{username}': now an active, approved developer with the new password.")
    else:
        db.execute(
            "INSERT INTO users (username, password_hash, role, display_name, designation, unit, on_call_rank, "
            "post, is_coordinator, active, approval_status, created_at) "
            "VALUES (?,?,'developer',?,NULL,NULL,NULL,NULL,0,1,'approved',?)",
            (username, hash_password(password), display_name, now_iso()),
        )
        db.commit()
        print(f"Created developer account '{username}'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
