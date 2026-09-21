"""All /api/* routes: auth, users/signup/approval, preferences, AI
scheduling, config CRUD.

Same conventions as the ENT Surgical Logbook project's api.py: every write
uses parameterized queries, every state-changing route sits behind
auth.login_required, and the developer role remains master control --
account creation/deletion, unit/post assignment, coordinator assignment,
signup approvals, and the master lists are developer-only.

v2 permission model (replaces the original direct-entry roster):
- Everyone can submit their OWN leave requests and duty preferences for a
  month (/api/preferences/*). This is the only user-facing "input" left --
  there is no manual roster cell edit for regular users.
- Only a unit's coordinator (users.is_coordinator, set by the developer) or
  the developer can generate/redo (POST /api/schedule/generate) or approve
  (POST /api/schedule/approve) that unit's schedule. Generation calls out to
  ai_schedule.py, which wraps the LLM call (or a clearly-labeled placeholder
  when no ANTHROPIC_API_KEY is configured) and validates the result.
- A draft (generated-but-not-approved) schedule's roster_entries are only
  visible to that unit's coordinator/developer -- the rest of the unit sees
  it once approved.
- Head of Unit (a post, independent of coordinator) gets exactly one extra
  right: editing role/designation/on_call_rank for other members of their
  OWN unit (see can_edit_profile_fields / update_user). It grants nothing
  else -- not unit, not post, not is_coordinator, not account lifecycle.
- The developer keeps a manual PUT /api/roster/entry as a break-glass fix
  for a bad AI-generated cell -- nobody else has any manual cell-edit path.
"""
import datetime
import json
import re

from flask import Blueprint, g, jsonify, request

from auth import (
    clean_username, client_ip, create_session, current_user,
    destroy_all_sessions_for, destroy_session, hash_password,
    login_required, rate_limit, record_attempt, set_session_cookie,
    clear_session_cookie, verify_password,
)
from db import get_db

api = Blueprint("api", __name__, url_prefix="/api")

ROLES = {"postgraduate", "fellow", "professor", "developer"}
# Every role that belongs to a unit's roster grid -- developer is master
# control only and doesn't sit in any unit's grid.
UNIT_ROLES = {"postgraduate", "fellow", "professor"}
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")


# ---------------------------------------------------------------- helpers
def row_to_user(row):
    if row is None:
        return None
    d = dict(row)
    return {
        "username": d["username"],
        "role": d["role"],
        "displayName": d["display_name"],
        "designation": d["designation"],
        "unit": d["unit"],
        "onCallRank": d["on_call_rank"],
        "post": d["post"],
        "isCoordinator": bool(d.get("is_coordinator", 0)),
        "active": bool(d.get("active", 1)),
        "approvalStatus": d.get("approval_status", "approved"),
        "createdAt": d["created_at"],
    }


def roster_entry_to_dict(row):
    d = dict(row)
    return {
        "id": d["id"],
        "username": d["username"],
        "date": d["entry_date"],
        "typeKey": d["type_key"],
        "note": d["note"],
        "updatedAt": d["updated_at"],
        "updatedBy": d["updated_by"],
    }


def get_config():
    row = get_db().execute("SELECT data FROM config WHERE id = 'lists'").fetchone()
    return json.loads(row["data"]) if row else {}


def user_capabilities(username):
    empty = {"isDeveloper": False, "isCoordinator": False, "isHeadOfUnit": False, "unit": None}
    if not username:
        return empty
    db = get_db()
    row = db.execute("SELECT role, unit, post, is_coordinator FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        return empty
    return {
        "isDeveloper": row["role"] == "developer",
        "isCoordinator": bool(row["is_coordinator"]),
        "isHeadOfUnit": row["post"] == "Head of Unit",
        "unit": row["unit"],
    }


def can_edit_profile_fields(actor, target_row):
    """Whether `actor` (g.user dict) may PATCH role/designation/onCallRank
    on `target_row` (a users row). Developer: always. Head of Unit: only
    another member of their own unit, never themselves, never a developer
    account. Nobody else."""
    if actor["role"] == "developer":
        return True
    return (
        actor.get("post") == "Head of Unit"
        and actor.get("unit")
        and actor["unit"] == target_row["unit"]
        and actor["username"] != target_row["username"]
        and target_row["role"] != "developer"
    )


def _valid_unit_key(unit, cfg=None):
    cfg = cfg or get_config()
    return any(u["key"] == unit for u in cfg.get("units", []))


# ------------------------------------------------------------------ auth
@api.post("/auth/signup")
def signup():
    body = request.get_json(force=True, silent=True) or {}
    username = clean_username(body.get("username"))
    password = body.get("password") or ""
    confirm = body.get("confirm") or ""
    display_name = (body.get("displayName") or username).strip()
    role = body.get("role") if body.get("role") in UNIT_ROLES else "postgraduate"

    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters (letters, numbers, . _ -)."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if password != confirm:
        return jsonify({"error": "Passwords do not match."}), 400

    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        return jsonify({"error": "That username is already taken."}), 409

    is_first_user = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0
    # Every self-signup waits for the developer to approve it, except the
    # very first account ever created (bootstrapping the developer account --
    # nobody exists yet who could approve it).
    final_role = "developer" if is_first_user else role
    approval_status = "approved" if is_first_user else "pending"

    cfg = get_config()
    unit = body.get("unit") if final_role in UNIT_ROLES else None
    if final_role in UNIT_ROLES:
        if not unit or not _valid_unit_key(unit, cfg):
            return jsonify({"error": "Select a valid unit (ENT 1-5)."}), 400

    designation = body.get("designation") if final_role == "professor" else None
    if final_role == "professor":
        if not designation or designation not in cfg.get("designations", []):
            return jsonify({"error": "Select a valid designation."}), 400

    on_call_rank = body.get("onCallRank") if final_role in UNIT_ROLES else None
    if on_call_rank and on_call_rank not in cfg.get("onCallRanks", []):
        return jsonify({"error": "Select a valid on-call rank."}), 400

    post = body.get("post") if final_role in UNIT_ROLES else None
    if post and post not in cfg.get("posts", []):
        return jsonify({"error": "Select a valid post."}), 400

    now = datetime.datetime.utcnow().isoformat() + "Z"
    db.execute(
        "INSERT INTO users (username, password_hash, role, display_name, designation, unit, on_call_rank, post, active, approval_status, created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
        (username, hash_password(password), final_role, display_name, designation, unit, on_call_rank, post, approval_status, now),
    )
    db.commit()

    if approval_status == "pending":
        return jsonify({
            "pending": True,
            "message": "Your account has been created and is waiting for approval from the developer before you can sign in.",
        })

    token = create_session(username)
    user = row_to_user(db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone())
    resp = jsonify({"user": user, "firstUser": is_first_user, "capabilities": user_capabilities(username)})
    return set_session_cookie(resp, token)


@api.post("/auth/login")
def login():
    body = request.get_json(force=True, silent=True) or {}
    username = clean_username(body.get("username"))
    password = body.get("password") or ""
    require_role = body.get("requireRole")

    rl_key_ip = f"login:{username}:{client_ip()}"
    rl_key_account = f"login:{username}"
    if rate_limit(rl_key_ip) or rate_limit(rl_key_account):
        return jsonify({"error": "Too many attempts. Wait 15 minutes and try again."}), 429

    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        record_attempt(rl_key_ip)
        record_attempt(rl_key_account)
        return jsonify({"error": "No account with that username."}), 401
    if not row["active"]:
        return jsonify({"error": "This account has been deactivated. Ask your developer admin to reactivate it."}), 403
    if row["approval_status"] == "pending":
        return jsonify({"error": "Your account is still awaiting approval from the developer."}), 403
    if require_role and row["role"] != require_role:
        return jsonify({"error": f"This account is not a {require_role} account."}), 403
    if not verify_password(row["password_hash"], password):
        record_attempt(rl_key_ip)
        record_attempt(rl_key_account)
        return jsonify({"error": "Incorrect password."}), 401

    token = create_session(username)
    resp = jsonify({"user": row_to_user(row), "capabilities": user_capabilities(username)})
    return set_session_cookie(resp, token)


@api.post("/auth/logout")
def logout():
    token = request.cookies.get("dutyroster_session")
    if token:
        destroy_session(token)
    resp = jsonify({"ok": True})
    return clear_session_cookie(resp)


@api.get("/auth/me")
def me():
    user = current_user()
    return jsonify({
        "user": row_to_user(user) if user else None,
        "capabilities": user_capabilities(user["username"]) if user else None,
    })


@api.post("/auth/change-password")
@login_required()
def change_password():
    body = request.get_json(force=True, silent=True) or {}
    old = body.get("oldPassword") or ""
    new = body.get("newPassword") or ""
    confirm = body.get("confirm") or ""
    if len(new) < 8:
        return jsonify({"error": "New password must be at least 8 characters."}), 400
    if new != confirm:
        return jsonify({"error": "New passwords do not match."}), 400
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (g.user["username"],)).fetchone()
    if not verify_password(row["password_hash"], old):
        return jsonify({"error": "Current password is incorrect."}), 400
    db.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(new), g.user["username"]))
    db.commit()
    destroy_all_sessions_for(g.user["username"])
    token = create_session(g.user["username"])
    resp = jsonify({"ok": True})
    return set_session_cookie(resp, token)


@api.post("/auth/forgot-password")
def forgot_password():
    body = request.get_json(force=True, silent=True) or {}
    username = clean_username(body.get("username"))
    note = (body.get("note") or "").strip()
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        return jsonify({"error": "No account with that username."}), 404
    db.execute(
        "INSERT INTO password_resets (username, note, status, requested_at) VALUES (?,?,'pending',?)",
        (username, note, datetime.datetime.utcnow().isoformat() + "Z"),
    )
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ users
@api.get("/users")
@login_required(role="developer")
def list_users():
    rows = get_db().execute("SELECT * FROM users ORDER BY unit, display_name").fetchall()
    return jsonify({"users": [row_to_user(r) for r in rows]})


@api.get("/users/<username>")
@login_required()
def get_user(username):
    if not (g.user["username"] == username or g.user["role"] == "developer"):
        return jsonify({"error": "forbidden"}), 403
    row = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"user": row_to_user(row)})


def _validate_profile_fields(body, role, cfg):
    """Shared validation for admin-create and admin-edit. Returns
    (designation, unit, on_call_rank, post, error_response_or_None)."""
    unit = body.get("unit") if role in UNIT_ROLES else None
    if role in UNIT_ROLES and (not unit or not _valid_unit_key(unit, cfg)):
        return None, None, None, None, (jsonify({"error": "Select a valid unit (ENT 1-5)."}), 400)

    designation = body.get("designation") if role == "professor" else None
    if role == "professor" and (not designation or designation not in cfg.get("designations", [])):
        return None, None, None, None, (jsonify({"error": "Select a valid designation."}), 400)

    on_call_rank = body.get("onCallRank") if role in UNIT_ROLES else None
    if on_call_rank and on_call_rank not in cfg.get("onCallRanks", []):
        return None, None, None, None, (jsonify({"error": "Select a valid on-call rank."}), 400)

    post = body.get("post") if role in UNIT_ROLES else None
    if post and post not in cfg.get("posts", []):
        return None, None, None, None, (jsonify({"error": "Select a valid post."}), 400)

    return designation, unit, on_call_rank, post, None


@api.post("/users")
@login_required(role="developer")
def admin_create_user():
    body = request.get_json(force=True, silent=True) or {}
    username = clean_username(body.get("username"))
    password = body.get("password") or ""
    role = body.get("role")
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if role not in ROLES:
        return jsonify({"error": "Invalid role."}), 400
    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        return jsonify({"error": "That username is already taken."}), 409

    designation, unit, on_call_rank, post, err = _validate_profile_fields(body, role, get_config())
    if err:
        return err

    now = datetime.datetime.utcnow().isoformat() + "Z"
    is_coordinator = 1 if body.get("isCoordinator") else 0
    # Admin-created accounts are pre-approved -- the developer creating the
    # account directly IS the approval.
    db.execute(
        "INSERT INTO users (username, password_hash, role, display_name, designation, unit, on_call_rank, post, is_coordinator, active, approval_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,'approved',?)",
        (username, hash_password(password), role, body.get("displayName") or username, designation, unit, on_call_rank, post, is_coordinator, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return jsonify({"user": row_to_user(row)})


@api.patch("/users/<username>")
@login_required()
def update_user(username):
    """Developer: full access, as before. Head of Unit: role/designation/
    onCallRank only, for someone else in their own unit, and never granting
    the developer role (see can_edit_profile_fields). Everyone else: 403."""
    body = request.get_json(force=True, silent=True) or {}
    db = get_db()
    existing = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not existing:
        return jsonify({"error": "not_found"}), 404

    is_dev = g.user["role"] == "developer"
    if not can_edit_profile_fields(g.user, existing):
        return jsonify({"error": "forbidden"}), 403

    if not is_dev:
        allowed_keys = {"role", "designation", "onCallRank"}
        extra = sorted(set(body.keys()) - allowed_keys)
        if extra:
            return jsonify({"error": f"Head of Unit can only edit role, designation and on-call rank (not {', '.join(extra)})."}), 403
        if body.get("role") == "developer":
            return jsonify({"error": "Head of Unit cannot grant the developer role."}), 403

    if is_dev and "active" in body:
        db.execute("UPDATE users SET active = ? WHERE username = ?", (1 if body["active"] else 0, username))
        if not body["active"]:
            destroy_all_sessions_for(username)

    if is_dev and "isCoordinator" in body:
        db.execute("UPDATE users SET is_coordinator = ? WHERE username = ?", (1 if body["isCoordinator"] else 0, username))

    role = body.get("role") if body.get("role") in ROLES else existing["role"]
    if "role" in body and body["role"] not in ROLES:
        return jsonify({"error": "Invalid role."}), 400

    # Only re-validate/overwrite the profile fields the caller actually sent
    # (or that the role change now requires) -- a lightweight PATCH that only
    # flips `active` shouldn't be forced to resend everything else.
    cfg = get_config()
    touches_profile = any(k in body for k in ("unit", "designation", "onCallRank", "post")) or "role" in body
    if touches_profile:
        merged = {
            "unit": body.get("unit", existing["unit"]) if is_dev else existing["unit"],
            "designation": body.get("designation", existing["designation"]),
            "onCallRank": body.get("onCallRank", existing["on_call_rank"]),
            "post": body.get("post", existing["post"]) if is_dev else existing["post"],
        }
        designation, unit, on_call_rank, post, err = _validate_profile_fields(merged, role, cfg)
        if err:
            return err
        db.execute(
            "UPDATE users SET role=?, unit=?, designation=?, on_call_rank=?, post=? WHERE username=?",
            (role, unit, designation, on_call_rank, post, username),
        )

    if is_dev and "displayName" in body and (body["displayName"] or "").strip():
        db.execute("UPDATE users SET display_name = ? WHERE username = ?", (body["displayName"].strip(), username))

    if is_dev and "password" in body and body["password"]:
        if len(body["password"]) < 8:
            return jsonify({"error": "New password must be at least 8 characters."}), 400
        db.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(body["password"]), username))
        destroy_all_sessions_for(username)

    db.commit()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return jsonify({"user": row_to_user(row)})


@api.delete("/users/<username>")
@login_required(role="developer")
def delete_user(username):
    if username == g.user["username"]:
        return jsonify({"error": "You can't delete your own account."}), 400
    db = get_db()
    row = db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    # Cascades to that person's roster_entries and sessions (see
    # schema_sqlite.sql) -- unlike the Logbook's entries, a duty roster has
    # no long-term training record to protect, so a straight delete is fine.
    db.execute("DELETE FROM users WHERE username = ?", (username,))
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------- signup approvals
@api.get("/signup-requests")
@login_required(role="developer")
def list_signup_requests():
    rows = get_db().execute("SELECT * FROM users WHERE approval_status = 'pending' ORDER BY created_at").fetchall()
    return jsonify({"requests": [row_to_user(r) for r in rows]})


@api.post("/signup-requests/<username>/approve")
@login_required(role="developer")
def approve_signup_request(username):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or row["approval_status"] != "pending":
        return jsonify({"error": "not_found"}), 404
    db.execute("UPDATE users SET approval_status = 'approved' WHERE username = ?", (username,))
    db.commit()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return jsonify({"user": row_to_user(row)})


@api.post("/signup-requests/<username>/reject")
@login_required(role="developer")
def reject_signup_request(username):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or row["approval_status"] != "pending":
        return jsonify({"error": "not_found"}), 404
    # Safe to hard-delete outright: a never-approved account can't have
    # logged any roster entries yet.
    db.execute("DELETE FROM users WHERE username = ?", (username,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------- password admin
def password_reset_row_to_dict(row):
    d = dict(row)
    return {
        "id": d["id"],
        "username": d["username"],
        "note": d["note"],
        "status": d["status"],
        "requestedAt": d["requested_at"],
        "resolvedAt": d["resolved_at"],
        "resolvedBy": d["resolved_by"],
    }


@api.get("/password-requests")
@login_required(role="developer")
def list_password_requests():
    rows = get_db().execute("SELECT * FROM password_resets ORDER BY requested_at DESC").fetchall()
    return jsonify({"requests": [password_reset_row_to_dict(r) for r in rows]})


@api.post("/password-requests/<int:req_id>/resolve")
@login_required(role="developer")
def resolve_password_request(req_id):
    db = get_db()
    row = db.execute("SELECT * FROM password_resets WHERE id = ?", (req_id,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    db.execute(
        "UPDATE password_resets SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
        (datetime.datetime.utcnow().isoformat() + "Z", g.user["username"], req_id),
    )
    db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ config
@api.get("/config")
def read_config():
    # Deliberately public (no login_required): the sign-up screen needs the
    # units/designations/on-call-rank/post lists before anyone has a
    # session, and none of this is sensitive -- it's dropdown metadata, not
    # roster or user data.
    return jsonify({"config": get_config()})


@api.patch("/config")
@login_required(role="developer")
def update_config():
    """Developer-only "Manage Lists" screen -- same JSON-blob-merge pattern
    as the Logbook project. Also how units are added/deleted (the master
    list of ENT 1-5 the user asked for): send the full replacement `units`
    array. Deleting a unit here is deliberately non-destructive to any
    existing user/roster row that still points at it (same "resolved
    app-side, not a SQL FK" rationale as type_key) -- it just stops
    appearing as a choice for new assignments."""
    body = request.get_json(force=True, silent=True) or {}
    db = get_db()
    cfg = get_config()
    cfg.update(body)
    db.execute("UPDATE config SET data = ? WHERE id = 'lists'", (json.dumps(cfg),))
    db.commit()
    return jsonify({"config": cfg})


# ------------------------------------------------------------------ roster
def _resolve_view_unit(requested_unit):
    """A non-developer can only ever view their OWN unit's grid (everyone in
    the unit sees the whole unit, nobody sees a different unit). The
    developer can view any unit and must pass one explicitly."""
    if g.user["role"] == "developer":
        if not requested_unit:
            return None, (jsonify({"error": "unit is required."}), 400)
        return requested_unit, None
    own_unit = g.user["unit"]
    if not own_unit:
        return None, (jsonify({"error": "Your account has no unit assigned yet -- ask the developer to set one."}), 400)
    if requested_unit and requested_unit != own_unit:
        return None, (jsonify({"error": "forbidden"}), 403)
    return own_unit, None


def _is_unit_coordinator(unit):
    return g.user["role"] == "developer" or (bool(g.user.get("is_coordinator")) and g.user.get("unit") == unit)


def schedule_run_to_dict(row):
    if not row:
        return {"status": "none", "redoCount": 0}
    d = dict(row)
    return {
        "unit": d["unit"],
        "month": d["month"],
        "status": d["status"],
        "redoCount": d["redo_count"],
        "extraInstructions": d["extra_instructions"],
        "aiNotes": d["ai_notes"],
        "conflicts": json.loads(d["conflicts_json"] or "[]"),
        "usedPlaceholder": bool(d["used_placeholder"]),
        "generatedAt": d["generated_at"],
        "generatedBy": d["generated_by"],
        "approvedAt": d["approved_at"],
        "approvedBy": d["approved_by"],
    }


def _get_schedule_run(db, unit, month):
    return db.execute("SELECT * FROM schedule_runs WHERE unit = ? AND month = ?", (unit, month)).fetchone()


@api.get("/roster")
@login_required()
def get_roster():
    """Read-only view. There is no direct roster editing left for regular
    users -- see /api/schedule/generate and /api/schedule/approve. A draft
    (generated but not yet approved) schedule is only visible to that
    unit's coordinator/developer; everyone else sees an empty grid with
    scheduleStatus telling the UI why."""
    month = (request.args.get("month") or "").strip()
    if not MONTH_RE.match(month):
        return jsonify({"error": "month must be YYYY-MM."}), 400
    unit, err = _resolve_view_unit((request.args.get("unit") or "").strip() or None)
    if err:
        return err

    db = get_db()
    people = db.execute(
        "SELECT * FROM users WHERE unit = ? AND role != 'developer' ORDER BY display_name",
        (unit,),
    ).fetchall()
    usernames = [p["username"] for p in people]

    run = _get_schedule_run(db, unit, month)
    status = run["status"] if run else "none"
    can_preview_draft = _is_unit_coordinator(unit)
    published = status == "approved"

    entries = []
    if usernames and (published or can_preview_draft):
        placeholders = ",".join("?" * len(usernames))
        rows = db.execute(
            f"SELECT * FROM roster_entries WHERE username IN ({placeholders}) AND entry_date LIKE ? ORDER BY entry_date",
            (*usernames, f"{month}-%"),
        ).fetchall()
        entries = [roster_entry_to_dict(r) for r in rows]

    return jsonify({
        "unit": unit,
        "month": month,
        "people": [row_to_user(p) for p in people],
        "entries": entries,
        "scheduleStatus": status,
        "published": published,
        "isCoordinatorView": can_preview_draft,
        "scheduleRun": schedule_run_to_dict(run) if can_preview_draft else None,
    })


@api.put("/roster/entry")
@login_required(role="developer")
def put_roster_entry():
    """Developer-only break-glass fix for a single cell. This is NOT a
    general editing path -- everyone else's only input is preferences, and
    the only way to change a published schedule is another generate/redo
    (see /api/schedule/generate). Kept so one bad AI-generated cell doesn't
    require regenerating an entire month from scratch."""
    body = request.get_json(force=True, silent=True) or {}
    target_username = clean_username(body.get("username")) if body.get("username") else None
    if not target_username:
        return jsonify({"error": "username is required."}), 400

    date = (body.get("date") or "").strip()
    if not DATE_RE.match(date):
        return jsonify({"error": "date must be YYYY-MM-DD."}), 400

    db = get_db()
    target = db.execute("SELECT * FROM users WHERE username = ?", (target_username,)).fetchone()
    if not target or target["role"] == "developer":
        return jsonify({"error": "not_found"}), 404

    type_key = body.get("typeKey")
    note = (body.get("note") or "").strip() or None
    now = datetime.datetime.utcnow().isoformat() + "Z"

    if type_key is None:
        db.execute("DELETE FROM roster_entries WHERE username = ? AND entry_date = ?", (target_username, date))
        db.commit()
        return jsonify({"entry": None})

    cfg = get_config()
    if not any(t["key"] == type_key for t in cfg.get("shiftLeaveTypes", [])):
        return jsonify({"error": "Unknown shift/leave type."}), 400

    db.execute(
        """INSERT INTO roster_entries (username, entry_date, type_key, note, updated_at, updated_by)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(username, entry_date)
           DO UPDATE SET type_key=excluded.type_key, note=excluded.note,
                         updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
        (target_username, date, type_key, note, now, g.user["username"]),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM roster_entries WHERE username = ? AND entry_date = ?", (target_username, date)
    ).fetchone()
    return jsonify({"entry": roster_entry_to_dict(row)})


# -------------------------------------------------------------- preferences
def leave_row_to_dict(row):
    d = dict(row)
    return {
        "id": d["id"], "username": d["username"], "startDate": d["start_date"],
        "endDate": d["end_date"], "typeKey": d["type_key"], "note": d["note"],
        "createdAt": d["created_at"], "updatedAt": d["updated_at"],
    }


@api.get("/preferences/leave")
@login_required()
def list_leave_requests():
    """Your own leave requests by default. Pass ?unit=... as a
    coordinator/developer to see everyone's in that unit (used to review
    before generating)."""
    target_unit = (request.args.get("unit") or "").strip() or None
    db = get_db()
    if target_unit:
        unit, err = _resolve_view_unit(target_unit)
        if err:
            return err
        if not _is_unit_coordinator(unit):
            return jsonify({"error": "forbidden"}), 403
        rows = db.execute(
            "SELECT lr.* FROM leave_requests lr JOIN users u ON u.username = lr.username "
            "WHERE u.unit = ? ORDER BY lr.start_date", (unit,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM leave_requests WHERE username = ? ORDER BY start_date", (g.user["username"],)
        ).fetchall()
    return jsonify({"requests": [leave_row_to_dict(r) for r in rows]})


@api.post("/preferences/leave")
@login_required()
def create_leave_request():
    body = request.get_json(force=True, silent=True) or {}
    start = (body.get("startDate") or "").strip()
    end = (body.get("endDate") or "").strip()
    if not DATE_RE.match(start) or not DATE_RE.match(end):
        return jsonify({"error": "startDate/endDate must be YYYY-MM-DD."}), 400
    if end < start:
        return jsonify({"error": "endDate must be on or after startDate."}), 400
    cfg = get_config()
    valid_leave_keys = {t["key"] for t in cfg.get("shiftLeaveTypes", []) if t.get("category") == "leave"}
    type_key = body.get("typeKey")
    if type_key not in valid_leave_keys:
        return jsonify({"error": "Select a valid leave type."}), 400
    note = (body.get("note") or "").strip() or None
    now = datetime.datetime.utcnow().isoformat() + "Z"
    db = get_db()
    db.execute(
        "INSERT INTO leave_requests (username, start_date, end_date, type_key, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (g.user["username"], start, end, type_key, note, now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM leave_requests WHERE id = last_insert_rowid()").fetchone()
    return jsonify({"request": leave_row_to_dict(row)})


@api.delete("/preferences/leave/<int:req_id>")
@login_required()
def delete_leave_request(req_id):
    db = get_db()
    row = db.execute("SELECT * FROM leave_requests WHERE id = ?", (req_id,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    if row["username"] != g.user["username"] and g.user["role"] != "developer":
        return jsonify({"error": "forbidden"}), 403
    db.execute("DELETE FROM leave_requests WHERE id = ?", (req_id,))
    db.commit()
    return jsonify({"ok": True})


def duty_pref_row_to_dict(row):
    d = dict(row)
    return {
        "username": d["username"], "month": d["month"],
        "preferredTypes": json.loads(d["preferred_types"] or "[]"),
        "avoidTypes": json.loads(d["avoid_types"] or "[]"),
        "preferredDates": json.loads(d["preferred_dates"] or "[]"),
        "avoidDates": json.loads(d["avoid_dates"] or "[]"),
        "maxConsecutiveOncalls": d["max_consecutive_oncalls"],
        "notes": d["notes"],
        "updatedAt": d["updated_at"],
    }


@api.get("/preferences/duty")
@login_required()
def get_duty_preferences():
    month = (request.args.get("month") or "").strip()
    if not MONTH_RE.match(month):
        return jsonify({"error": "month must be YYYY-MM."}), 400
    target_unit = (request.args.get("unit") or "").strip() or None
    db = get_db()
    if target_unit:
        unit, err = _resolve_view_unit(target_unit)
        if err:
            return err
        if not _is_unit_coordinator(unit):
            return jsonify({"error": "forbidden"}), 403
        rows = db.execute(
            "SELECT dp.* FROM duty_preferences dp JOIN users u ON u.username = dp.username "
            "WHERE u.unit = ? AND dp.month = ?", (unit, month),
        ).fetchall()
        return jsonify({"preferences": [duty_pref_row_to_dict(r) for r in rows]})
    row = db.execute(
        "SELECT * FROM duty_preferences WHERE username = ? AND month = ?", (g.user["username"], month)
    ).fetchone()
    return jsonify({"preference": duty_pref_row_to_dict(row) if row else None})


@api.put("/preferences/duty")
@login_required()
def put_duty_preferences():
    body = request.get_json(force=True, silent=True) or {}
    month = (body.get("month") or "").strip()
    if not MONTH_RE.match(month):
        return jsonify({"error": "month must be YYYY-MM."}), 400
    cfg = get_config()
    valid_duty_keys = {t["key"] for t in cfg.get("shiftLeaveTypes", []) if t.get("category") in ("shift", "oncall", "off")}

    def _clean_type_list(key):
        vals = body.get(key)
        return [v for v in vals if v in valid_duty_keys] if isinstance(vals, list) else []

    def _clean_date_list(key):
        vals = body.get(key)
        return [v for v in vals if isinstance(v, str) and DATE_RE.match(v) and v.startswith(month)] if isinstance(vals, list) else []

    preferred_types = _clean_type_list("preferredTypes")
    avoid_types = _clean_type_list("avoidTypes")
    preferred_dates = _clean_date_list("preferredDates")
    avoid_dates = _clean_date_list("avoidDates")
    max_consec = body.get("maxConsecutiveOncalls")
    try:
        max_consec = int(max_consec) if max_consec not in (None, "") else None
    except (TypeError, ValueError):
        max_consec = None
    notes = (body.get("notes") or "").strip() or None
    now = datetime.datetime.utcnow().isoformat() + "Z"

    db = get_db()
    db.execute(
        """INSERT INTO duty_preferences (username, month, preferred_types, avoid_types, preferred_dates, avoid_dates, max_consecutive_oncalls, notes, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(username, month) DO UPDATE SET
             preferred_types=excluded.preferred_types, avoid_types=excluded.avoid_types,
             preferred_dates=excluded.preferred_dates, avoid_dates=excluded.avoid_dates,
             max_consecutive_oncalls=excluded.max_consecutive_oncalls, notes=excluded.notes,
             updated_at=excluded.updated_at""",
        (g.user["username"], month, json.dumps(preferred_types), json.dumps(avoid_types),
         json.dumps(preferred_dates), json.dumps(avoid_dates), max_consec, notes, now),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM duty_preferences WHERE username = ? AND month = ?", (g.user["username"], month)
    ).fetchone()
    return jsonify({"preference": duty_pref_row_to_dict(row)})


# ----------------------------------------------------------- AI scheduling
@api.get("/schedule/status")
@login_required()
def schedule_status():
    month = (request.args.get("month") or "").strip()
    if not MONTH_RE.match(month):
        return jsonify({"error": "month must be YYYY-MM."}), 400
    unit, err = _resolve_view_unit((request.args.get("unit") or "").strip() or None)
    if err:
        return err
    run = _get_schedule_run(get_db(), unit, month)
    return jsonify({"scheduleRun": schedule_run_to_dict(run)})


@api.post("/schedule/generate")
@login_required()
def generate_schedule():
    """Coordinator (own unit) or developer (any unit). Wipes and re-writes
    every roster_entries row for this unit+month. There is no separate
    /redo route -- passing extraInstructions on a unit/month that already
    has a draft/approved run IS the redo, bumping redoCount and re-running
    the model with that steering text plus its own last output as context."""
    body = request.get_json(force=True, silent=True) or {}
    month = (body.get("month") or "").strip()
    unit = (body.get("unit") or "").strip()
    if not MONTH_RE.match(month):
        return jsonify({"error": "month must be YYYY-MM."}), 400
    if not unit or not _valid_unit_key(unit):
        return jsonify({"error": "Unknown unit."}), 400
    if not _is_unit_coordinator(unit):
        return jsonify({"error": "Only this unit's coordinator (or the developer) can generate its schedule."}), 403

    extra_instructions = (body.get("extraInstructions") or "").strip() or None

    db = get_db()
    people = db.execute(
        "SELECT * FROM users WHERE unit = ? AND role != 'developer' AND active = 1 ORDER BY display_name", (unit,)
    ).fetchall()
    if not people:
        return jsonify({"error": "This unit has no active members to schedule."}), 400
    usernames = [p["username"] for p in people]
    placeholders = ",".join("?" * len(usernames))

    leave_rows = db.execute(
        f"SELECT * FROM leave_requests WHERE username IN ({placeholders})", tuple(usernames)
    ).fetchall()
    pref_rows = db.execute(
        f"SELECT * FROM duty_preferences WHERE username IN ({placeholders}) AND month = ?", (*usernames, month)
    ).fetchall()

    cfg = get_config()
    existing_run = _get_schedule_run(db, unit, month)

    from ai_schedule import generate_schedule as run_ai_schedule
    result = run_ai_schedule(
        unit=unit,
        month=month,
        people=[dict(p) for p in people],
        leave_requests=[dict(r) for r in leave_rows],
        duty_preferences=[dict(r) for r in pref_rows],
        config=cfg,
        extra_instructions=extra_instructions,
        previous_notes=(existing_run["ai_notes"] if existing_run else None),
    )
    if result.get("error"):
        return jsonify({"error": result["error"]}), 502

    now = datetime.datetime.utcnow().isoformat() + "Z"
    db.execute(
        f"DELETE FROM roster_entries WHERE username IN ({placeholders}) AND entry_date LIKE ?",
        (*usernames, f"{month}-%"),
    )
    valid_type_keys = {t["key"] for t in cfg.get("shiftLeaveTypes", [])}
    valid_usernames = set(usernames)
    inserted = 0
    for entry in result.get("entries", []):
        u, d_, tk = entry.get("username"), entry.get("date"), entry.get("typeKey")
        if u not in valid_usernames or not d_ or not DATE_RE.match(d_) or not d_.startswith(month) or tk not in valid_type_keys:
            continue
        db.execute(
            """INSERT INTO roster_entries (username, entry_date, type_key, note, updated_at, updated_by)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(username, entry_date) DO UPDATE SET
                 type_key=excluded.type_key, note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
            (u, d_, tk, None, now, g.user["username"]),
        )
        inserted += 1

    redo_count = (existing_run["redo_count"] + 1) if existing_run else 0
    db.execute(
        """INSERT INTO schedule_runs (unit, month, status, redo_count, extra_instructions, ai_notes, conflicts_json, used_placeholder, generated_at, generated_by)
           VALUES (?,?,'draft',?,?,?,?,?,?,?)
           ON CONFLICT(unit, month) DO UPDATE SET
             status='draft', redo_count=excluded.redo_count, extra_instructions=excluded.extra_instructions,
             ai_notes=excluded.ai_notes, conflicts_json=excluded.conflicts_json, used_placeholder=excluded.used_placeholder,
             generated_at=excluded.generated_at, generated_by=excluded.generated_by,
             approved_at=NULL, approved_by=NULL""",
        (unit, month, redo_count, extra_instructions, result.get("notes"), json.dumps(result.get("conflicts", [])),
         1 if result.get("usedPlaceholder") else 0, now, g.user["username"]),
    )
    db.commit()
    run = _get_schedule_run(db, unit, month)
    return jsonify({"scheduleRun": schedule_run_to_dict(run), "entriesWritten": inserted})


@api.post("/schedule/approve")
@login_required()
def approve_schedule():
    body = request.get_json(force=True, silent=True) or {}
    month = (body.get("month") or "").strip()
    unit = (body.get("unit") or "").strip()
    if not MONTH_RE.match(month) or not unit:
        return jsonify({"error": "unit and month (YYYY-MM) are required."}), 400
    if not _is_unit_coordinator(unit):
        return jsonify({"error": "Only this unit's coordinator (or the developer) can approve its schedule."}), 403

    db = get_db()
    run = _get_schedule_run(db, unit, month)
    if not run or run["status"] != "draft":
        return jsonify({"error": "There's no draft schedule to approve for this unit/month -- generate one first."}), 400
    now = datetime.datetime.utcnow().isoformat() + "Z"
    db.execute(
        "UPDATE schedule_runs SET status='approved', approved_at=?, approved_by=? WHERE unit=? AND month=?",
        (now, g.user["username"], unit, month),
    )
    db.commit()
    run = _get_schedule_run(db, unit, month)
    return jsonify({"scheduleRun": schedule_run_to_dict(run)})
