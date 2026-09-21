# ENT Duty Roster

A monthly duty roster for the postgraduate and fellowship programme across ENT Units 1–5. Same architecture as the ENT Surgical Logbook project this was split off from: Flask + SQLite backend, hand-rolled single-file-per-layer frontend (`app.js`/`styles.css`/`index.html`), server-side sessions, scrypt password hashing.

**v2 change:** there is no more direct roster editing. Everyone submits leave requests and duty preferences; a unit's coordinator generates the actual schedule from those preferences via an AI call (or redoes it with extra instructions), then approves it to publish it to the unit. See "How scheduling works now" below — this is a real change in what the app does, not just a UI refresh.

## Running it locally

```
cd backend
pip install -r ../requirements.txt
python3 app.py
```

Opens on http://127.0.0.1:8000. The first account anyone signs up with is automatically made the **Developer** (master control) account; every account after that needs the developer's approval before it can sign in.

To try it with realistic-looking data already filled in instead of an empty database, run the demo seeder first:

```
cd backend
python3 seed_demo.py
python3 app.py
```

That creates a developer account, 2–3 people in each of ENT 1–5, a few sample leave requests and duty preferences, and one already-approved demo schedule for ENT 1 so the roster isn't empty on first look. `prof.rao` (ENT 1) and `pg.verma` (ENT 2) are seeded as that unit's coordinator — log in as either and try Generate/Redo/Approve on the Roster screen.

**Demo login:** `developer` / `demo12345` (every seeded account shares that same placeholder password — change it before showing this to anyone else, and definitely before any real deployment).

### Creating your real developer account

Don't reuse the demo password for real use, and don't hardcode a real password into `seed_demo.py` or any other file that goes into source control. Instead, run `create_admin.py` once, passing the username and password as environment variables on the command itself (never as command-line arguments, which end up in shell history):

```
cd backend
ADMIN_USERNAME=youruser ADMIN_PASSWORD='yourpassword' python3 create_admin.py
```

Safe to re-run — if the username already exists, it resets that account's password and makes sure it's an active, approved developer account instead of creating a duplicate. On Render, run the same command from the web service's shell once it's deployed (its persistent disk is where `DUTYROSTER_DB_PATH` should already point).

## How scheduling works now

- **Everyone** can submit their own leave requests (a date range + leave type) and duty preferences (preferred/avoided duty types, specific dates, a max-consecutive-on-calls cap, freeform notes) for a month, from **My Preferences**. This is now the *only* way a regular member affects the schedule — there is no per-cell grid edit for them at all.
- **A unit's coordinator** — an independent flag the developer sets on one specific account (`is_coordinator`; see Manage Users), not tied to role, post or designation — can **Generate** a schedule for their unit from the Roster screen. This sends everyone's leave requests, preferences, and the unit's roster to an AI call and gets back a full month's schedule. If it's not right, **Redo** with extra freeform instructions (e.g. "give Dr. Sharma fewer night shifts") re-runs generation with that steering text plus the model's own last notes as context.
- A freshly generated/redone schedule is a **draft** — visible only to that unit's coordinator and the developer. The coordinator **Approves** it to publish it, at which point the whole unit can see it (still read-only).
- **Head of Unit** (a `post`, independent of coordinator) gets exactly one extra right: editing **role, designation, and on-call rank** for other members of their own unit, from the new **My Unit** screen. It grants nothing else — not unit, not post, not coordinator status, not account creation/deactivation. A Head of Unit and a coordinator can be the same person or two different people (the demo seeds one of each).
- The **developer** keeps a break-glass manual roster-cell fix (visible directly on the Roster grid as developer) — see "A deliberate deviation from the original request" below for why this exists.

### Setting up real AI generation

Generation calls the Anthropic API. Set an environment variable before starting the server:

```
export ANTHROPIC_API_KEY=sk-ant-...
```

On Render, add this under the Web Service's Environment settings. Without it, **Generate/Redo still work**, but they fall back to a clearly-labeled placeholder rotation (visible as a "placeholder mode" chip and a red note in the UI) that only respects leave requests — it ignores duty preferences and staffing balance entirely, and exists solely so the workflow can be demoed and tested without an API key. Every real generation is a billed, non-deterministic API call — there is no caching and no free tier — so budget for that once a key is configured. `ANTHROPIC_MODEL` can override the default model.

Whichever path ran, the result passes through a validator (`backend/ai_schedule.py`) that flags — but does not block — obvious problems: a person scheduled to work on a day they requested leave, someone double-booked, or a day with no on-call coverage. These show up as a "Conflicts found" list on the Roster screen for the coordinator to act on with a redo.

### A deliberate deviation from the original request

The original spec for this version said preferences + generate/approve should be the *only* path — no direct entry at all. I kept one narrow exception: the developer can still fix a single roster cell directly. Reasoning: this app now has no other way to correct a broken or incomplete AI-generated cell short of regenerating (and possibly re-approving) an entire month, and an LLM call is not guaranteed to produce a fully valid schedule every time. Regular users and coordinators still have no manual cell-edit path at all — only the developer, who already has master-control override everywhere else in this app. If you'd rather this not exist, it's a small removal in `api.py`'s `put_roster_entry` route.

### Other things worth knowing before relying on this

- The validator's "no on-call coverage" and "double-booked" checks are basic and were not tuned against your unit's real staffing rules (minimum concurrent on-calls, weekend rules, etc.) — expect it to flag things you don't actually consider problems, and possibly miss ones you do, until those rules are made explicit.
- The placeholder rotation is a real fallback path, not a stub — it will run in production if `ANTHROPIC_API_KEY` is ever unset or the API call fails, and it produces a schedule that looks complete but was not generated with any judgment. The "placeholder mode" label is the only thing distinguishing it in the UI.
- A coordinator does not have to be a member of the unit they coordinate in the data model, though the seeded demo always makes them one — the developer can technically assign anyone. Worth deciding whether to restrict that.

## What's in it

- **Roles:** Postgraduate, Fellow, Professor (with sub-designation: Assistant / Associate / Professor / Senior Professor), and Developer (master control, no unit).
- **Per-person profile fields:** unit (ENT 1–5) and post (Head of Unit / Other) are developer-only; role, designation and on-call rank can also be set by the Head of Unit for other members of their own unit.
- **Coordinator:** an independent per-person flag (developer-only) that's the sole gate on generating/approving a unit's schedule.
- **My Preferences:** everyone's leave requests and duty preferences for a month — the only input into the schedule.
- **Roster grid:** day-by-day, read-only once published; a draft is visible only to the coordinator/developer.
- **Manage Lists** (developer only): the shift/leave type dropdown's own choices (tagged `shift`/`oncall`/`off`/`leave` — that tag drives what counts as a leave type vs. a duty type in Preferences), the ENT 1–5 unit master list, designations, on-call ranks, and posts — all editable without touching code.
- **Sign-up approvals** (developer only): every self-signup waits for developer approval before it can log in.

## Files

```
backend/
  app.py            Flask app factory, security headers, static routes
  api.py            All /api/* routes (auth, users, preferences, AI scheduling, config)
  ai_schedule.py     The AI call + validation + offline placeholder fallback
  auth.py           Sessions, password hashing, rate limiting
  db.py             SQLite connection + schema bootstrap + default config seed
  schema_sqlite.sql SQLite schema (users, leave_requests, duty_preferences, schedule_runs, roster_entries, config, ...)
  seed_demo.py      Optional demo-data seeder, placeholder password (see above)
  create_admin.py   Provisions one real developer account from env vars (see above) -- never edit in a real password
static/
  index.html, app.js, styles.css   The whole frontend
data/               dutyroster.db lives here once the app has run (gitignored)
```

## Deploying online later

`requirements.txt` and `Procfile` are already set up for Render (`gunicorn -w 2 -b 0.0.0.0:$PORT --chdir backend app:app`), mirroring the Logbook project's deployment. Push this folder to GitHub and point a Render Web Service at it — remember to also set `ANTHROPIC_API_KEY` in its Environment settings if you want real AI generation rather than the placeholder rotation.
