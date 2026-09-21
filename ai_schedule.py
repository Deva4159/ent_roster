"""AI-driven schedule generation.

Turns one unit's submitted leave requests + duty preferences into a full
month's roster_entries. Two paths:

1. Real path: calls the Anthropic Messages API (the `anthropic` package,
   ANTHROPIC_API_KEY from the environment) with a strict "return only JSON"
   instruction, parses the result, and validates it (see
   validate_schedule). This is a real, billed API call made once per
   generate/redo click -- there is no caching, no free tier, and no
   guarantee of determinism between two calls with identical inputs.

2. Placeholder path: when ANTHROPIC_API_KEY isn't set, falls back to a
   deterministic round-robin so the generate -> redo -> approve workflow
   can still be exercised completely offline (per the project's own
   "render the offline site first" sequencing). This is NOT
   preference-aware or optimized in any way, and every result it produces
   is labeled usedPlaceholder=True so the UI can say so plainly -- it
   exists to demo the *workflow*, not to be mistaken for the real feature.

Either path's output is re-validated here before api.py trusts it. This
project deliberately has no manual per-cell edit for regular users (see
api.py's module docstring), so a malformed or preference-ignoring result
has no other safety net besides being caught here and shown to the
coordinator as `conflicts`, for them to fix with a redo.
"""
import datetime
import json
import os

ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
MAX_TOKENS = 8000

SYSTEM_PROMPT = """You are a hospital duty-roster scheduling assistant for an \
otolaryngology (ENT) unit. You will be given the unit's members, their \
submitted leave requests and duty preferences for one calendar month, and \
the list of valid shift/leave type keys. Produce a complete day-by-day \
schedule for that month.

Hard rules (never violate these):
1. If a person has a leave request covering a date, their entry for that \
date MUST use that leave request's own typeKey (do not schedule them for \
duty on a day they requested leave).
2. Only use usernames from the given people list and typeKeys from the \
given duty/leave type list.
3. Give each person at most one entry per date.
4. Every date should have at least one person assigned an "oncall"-category \
type if the unit has any oncall-category type and any eligible member \
not on leave that day.

Soft preferences (do your best, but hard rules above always win):
- Respect each person's preferredTypes/avoidTypes and preferredDates/avoidDates.
- Respect maxConsecutiveOncalls if given.
- Distribute duty/on-call/off days reasonably evenly across the unit's \
members over the month.
- Weigh any freeform notes and extraInstructions/previousNotes given.

Respond with ONLY a single JSON object, no markdown fences, no prose \
before or after it, matching exactly this shape:
{"entries": [{"username": "...", "date": "YYYY-MM-DD", "typeKey": "..."}, ...], \
"notes": "a short (2-5 sentence) explanation of your approach and any \
preferences or hard rules you were not able to fully satisfy"}
"""


def _days_in_month(month):
    year, mon = (int(x) for x in month.split("-"))
    first = datetime.date(year, mon, 1)
    next_month = datetime.date(year + 1, 1, 1) if mon == 12 else datetime.date(year, mon + 1, 1)
    return [f"{month}-{d:02d}" for d in range(1, (next_month - first).days + 1)]


def _leave_map(people_usernames, leave_requests, days):
    """{(username, date): type_key} for every day a leave request covers,
    clipped to this month's days."""
    out = {}
    for lr in leave_requests:
        if lr["username"] not in people_usernames:
            continue
        for d in days:
            if lr["start_date"] <= d <= lr["end_date"]:
                out[(lr["username"], d)] = lr["type_key"]
    return out


def _duty_prefs_by_user(duty_preferences):
    out = {}
    for dp in duty_preferences:
        out[dp["username"]] = {
            "preferredTypes": json.loads(dp.get("preferred_types") or "[]"),
            "avoidTypes": json.loads(dp.get("avoid_types") or "[]"),
            "preferredDates": json.loads(dp.get("preferred_dates") or "[]"),
            "avoidDates": json.loads(dp.get("avoid_dates") or "[]"),
            "maxConsecutiveOncalls": dp.get("max_consecutive_oncalls"),
            "notes": dp.get("notes"),
        }
    return out


def _build_input_payload(unit, month, people, leave_requests, duty_preferences, config, extra_instructions, previous_notes):
    days = _days_in_month(month)
    types = config.get("shiftLeaveTypes", [])
    return {
        "unit": unit,
        "month": month,
        "days": days,
        "dutyLeaveTypes": [{"key": t["key"], "label": t["label"], "category": t.get("category")} for t in types],
        "people": [
            {
                "username": p["username"],
                "displayName": p["display_name"],
                "role": p["role"],
                "designation": p.get("designation"),
                "onCallRank": p.get("on_call_rank"),
                "post": p.get("post"),
            }
            for p in people
        ],
        "leaveRequests": [
            {"username": lr["username"], "startDate": lr["start_date"], "endDate": lr["end_date"], "typeKey": lr["type_key"], "note": lr.get("note")}
            for lr in leave_requests
        ],
        "dutyPreferences": [
            {"username": u, **prefs} for u, prefs in _duty_prefs_by_user(duty_preferences).items()
        ],
        "extraInstructions": extra_instructions,
        "previousNotes": previous_notes,
    }


def _extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    return json.loads(text)


def _call_anthropic(payload):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None, None  # caller falls back to placeholder -- no key configured yet

    try:
        import anthropic
    except ImportError:
        return None, "ANTHROPIC_API_KEY is set but the 'anthropic' package isn't installed on the server (pip install anthropic)."

    try:
        client = anthropic.Anthropic(api_key=api_key)
        user_prompt = "Schedule this unit's month from this input:\n\n" + json.dumps(payload, indent=2)
        last_err = None
        for attempt in range(2):
            prompt = user_prompt if attempt == 0 else (
                user_prompt + "\n\nYour previous reply was not valid JSON matching the required shape. "
                "Reply again with ONLY the JSON object, nothing else."
            )
            resp = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(block.text for block in resp.content if getattr(block, "type", None) == "text")
            try:
                parsed = _extract_json(text)
                if isinstance(parsed, dict) and isinstance(parsed.get("entries"), list):
                    return parsed, None
                last_err = "Model response was JSON but not in the expected {entries, notes} shape."
            except (json.JSONDecodeError, ValueError) as e:
                last_err = f"Model did not return valid JSON: {e}"
        return None, last_err
    except Exception as e:  # noqa: BLE001 -- surface any SDK/network error as a generation failure, not a 500
        return None, f"AI scheduling request failed: {e}"


def _placeholder_schedule(unit, month, people, leave_requests, config):
    """Deterministic offline stand-in -- see module docstring. Ignores
    preferences entirely; only respects leave requests (hard rule 1) so the
    validator has something meaningful to check even without a real key."""
    days = _days_in_month(month)
    usernames = [p["username"] for p in people]
    leaves = _leave_map(set(usernames), leave_requests, days)
    types = config.get("shiftLeaveTypes", [])
    rotatable = [t["key"] for t in types if t.get("category") in ("shift", "oncall")] or [t["key"] for t in types]

    entries = []
    if usernames and rotatable:
        for day_idx, date in enumerate(days):
            for person_idx, username in enumerate(usernames):
                if (username, date) in leaves:
                    entries.append({"username": username, "date": date, "typeKey": leaves[(username, date)]})
                    continue
                type_key = rotatable[(day_idx + person_idx) % len(rotatable)]
                entries.append({"username": username, "date": date, "typeKey": type_key})

    notes = (
        "Placeholder rotation -- ANTHROPIC_API_KEY is not configured on this server, so no real AI call was "
        "made. This fills the calendar with a simple day/person rotation that only respects submitted leave "
        "requests; it ignores duty preferences and staffing balance entirely. Set ANTHROPIC_API_KEY and redo "
        "to get an actual AI-generated schedule."
    )
    return {"entries": entries, "notes": notes}


def validate_schedule(entries, people, leave_requests, month, config):
    """Returns a list of human-readable conflict strings. Never raises --
    a validator that can crash the generate endpoint would be worse than
    no validator. Purely informational: api.py still writes whatever
    passes its own basic type/username/date checks; this is what the
    coordinator sees to decide whether to redo."""
    conflicts = []
    try:
        days = _days_in_month(month)
        usernames = {p["username"] for p in people}
        types_by_key = {t["key"]: t for t in config.get("shiftLeaveTypes", [])}
        oncall_keys = {k for k, t in types_by_key.items() if t.get("category") == "oncall"}
        leaves = _leave_map(usernames, leave_requests, days)

        seen = {}
        for e in entries:
            key = (e.get("username"), e.get("date"))
            if key in seen:
                conflicts.append(f"{e.get('username')} was assigned twice on {e.get('date')} -- kept the last one.")
            seen[key] = e.get("typeKey")

        for (username, date), leave_type in leaves.items():
            assigned = seen.get((username, date))
            if assigned is not None and assigned != leave_type:
                conflicts.append(f"{username} is on approved leave on {date} but was scheduled for '{assigned}' instead.")
            elif assigned is None:
                conflicts.append(f"{username} is on approved leave on {date} but has no entry at all.")

        if oncall_keys:
            eligible = {p["username"] for p in people}
            for date in days:
                on_leave_today = {u for (u, d) in leaves if d == date}
                covered = any(
                    seen.get((u, date)) in oncall_keys for u in eligible if u not in on_leave_today
                )
                if not covered and (eligible - on_leave_today):
                    conflicts.append(f"No on-call coverage on {date}.")
    except Exception as e:  # noqa: BLE001
        conflicts.append(f"(validator itself hit an error and stopped early: {e})")
    return conflicts


def generate_schedule(unit, month, people, leave_requests, duty_preferences, config, extra_instructions, previous_notes):
    """Returns {"entries": [...], "notes": str, "conflicts": [...],
    "usedPlaceholder": bool} or {"error": str}."""
    payload = _build_input_payload(unit, month, people, leave_requests, duty_preferences, config, extra_instructions, previous_notes)

    parsed, err = _call_anthropic(payload)
    used_placeholder = False
    if parsed is None and err:
        return {"error": err}
    if parsed is None:
        parsed = _placeholder_schedule(unit, month, people, leave_requests, config)
        used_placeholder = True

    entries = [e for e in parsed.get("entries", []) if isinstance(e, dict)]
    notes = parsed.get("notes") or ""
    conflicts = validate_schedule(entries, people, leave_requests, month, config)
    return {"entries": entries, "notes": notes, "conflicts": conflicts, "usedPlaceholder": used_placeholder}
