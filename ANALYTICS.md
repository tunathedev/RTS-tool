# Usage analytics → private Google Sheet

The app can record lightweight usage to a **private Google Sheet you own**. It is
**off by default**, needs **no backend**, asks for **no permissions** (no location),
and shows **nothing in the app** except a one-line footer notice. Nothing is written
to the public Firebase database.

## What is captured
Per event: timestamp, profile name (or "(not signed in)"), the event, a small
detail, **date / hour / weekday**, a **session id**, and device context — a random
per-device id, phone/tablet/desktop, OS, browser, installed-as-app vs browser,
timezone, language, screen + viewport size, network type, light/dark, referrer,
and app version.

**Not captured:** location, IP address, PINs, or any feed/message contents.

Events: `app_open` (before login too), `login`, `logout/session_end`, `switch_user`,
`screen` (which view), `pull_add`, `pull_remove`, `floor_set`, `floor_photo`,
`hole`, `feed_post`, `feed_react`, `task_add`, `task_claim`, `task_done`,
`item_view`, `catalog_save`, `catalog_delete`, `scan`, `search`, `filter`,
`copy_list`, `share_day`, `profile_new`, `profile_delete`, and the security
signals **`pin_fail`** and **`master_used`** (1905).

The Sheet auto-builds three tabs: **Dashboard** (KPIs, by-event/person/screen,
logins-per-day chart, by-hour, devices), **Review** (possible outsiders), and
**Security** (failed PINs + master uses).

## Spotting outsiders ("is corporate looking?")
In the Sheet, sort/filter by **device** and **type/os/browser**. Signals that stand
out: a **desktop / Windows** device (the team uses phones), a **device id you've
never seen**, an **unfamiliar profile name**, a **different timezone**, or an
`app_open` with no matching `login` (someone hit the screen but didn't sign in).
This is a strong hint, not proof — without IP it can't be definitive.

## One-time setup (~5 min)
1. Create a new **Google Sheet** (this is where the data lands — keep it private).
2. **Extensions → Apps Script.** Delete the default code and paste the contents of
   [`tools/analytics-sheet.gs`](./tools/analytics-sheet.gs). Save.
3. **Deploy → New deployment → select type “Web app.”**
   - Execute as: **Me**
   - Who has access: **Anyone** (this only lets the app *append* rows; nobody can
     read your Sheet through it)
   - Deploy, authorize, and **copy the Web app URL** (ends in `/exec`).
4. In `sync-config.js`, set `window.ANALYTICS_URL = "<that /exec URL>";` and commit.
5. Deploy the app (auto-updates). Open it once; a `rows` header + events appear in
   the Sheet within a minute.

To turn it **off**, set `window.ANALYTICS_URL = ""` and commit.

## Notes
- Events are **batched** and sent in the background (on a timer, and reliably on
  app close via `sendBeacon`), so it never slows the app; unsent events are kept
  locally and retried next open.
- Tell the team the app records basic usage (the footer says so) — the clean thing
  to do for internal monitoring.
- Since events include employee names + device info, treat the Sheet as internal.
