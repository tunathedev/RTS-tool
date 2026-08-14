# Security notes — SA50 RTS Ready

## The Firebase Web API key is **not** a secret
`sync-config.js` contains a Firebase **Web** API key (`AIzaSy…`). Google designs
these to be embedded in client-side code and committed to public repos — it only
identifies the Firebase project, it does **not** grant data access. Secret
scanners flag the `AIzaSy…` pattern, but for a Firebase Web key this is expected
and **safe**. Do **not** bother rotating it; that would not improve security.

The real security boundary for Firebase is **Database Rules + App Check**, below.

## What the app stores in the cloud
Under `rts/` in Realtime Database: catalog edits, pull list, production plan,
case-pack sizes, profiles (name/emoji/color/**PIN**), the shift feed (posts +
photos), tasks, floor-log photos, and archived daily pull lists. PINs are a
casual gate, stored as-is. Treat this DB as **internal, not confidential**.

## Hardening checklist

### 1. Database rules (defense-in-depth, zero downtime)
Paste [`firebase.rules.json`](./firebase.rules.json) into
**Firebase console → Realtime Database → Rules → Publish**. It keeps the app
working exactly as-is and adds size caps so nobody can bloat the DB.

### 2. App Check (the real fix — do this carefully, staged, no downtime)
App Check makes Firebase reject requests that don't come from *your* app, so a
random script with the public config can't touch the DB. Roll it out in order:

1. **Firebase console → App Check → Apps → your web app → reCAPTCHA v3.**
   Register and copy the **site key**.
2. In `sync-config.js`, set `appCheckKey: "<site key>"`. Commit + deploy. The app
   now *sends* App Check tokens but enforcement is still off — **nothing breaks.**
3. In **App Check → APIs → Realtime Database**, leave it in **Monitor** (unenforced)
   for a day. Watch the metrics show mostly "verified" requests.
4. Only once verified requests look healthy, switch Realtime Database to
   **Enforce.** ⚠️ Do **not** Enforce before steps 2–3 are deployed and verified —
   enforcing early blocks every request and takes the app offline until you undo it.
   To roll back instantly, set it back to **Unenforced.**
   - Local testing after enforcing: set `appCheckDebug` in `sync-config.js` to a
     debug token from **App Check → Apps → Manage debug tokens** (never commit a
     production debug token).

### 3. (Optional) Restrict the API key
**Google Cloud console → APIs & Services → Credentials → the Browser key →
Application restrictions → HTTP referrers**, and add
`tunathedev.github.io/*` (and `localhost:*` for testing). Stops the key being
reused from other sites. Nice-to-have; App Check is stronger.

### 4. GitHub settings (free on public repos)
**Repo → Settings → Code security:** enable **Secret scanning** and **Push
protection** (catches a *real* secret before it's ever pushed), and **Dependabot
alerts**. These don't remove the Firebase key alert (it's a Web key, expected) —
they protect you if an actual credential is ever committed by mistake.

## Reporting
Found something? Open a private issue or contact the SA50 maintainer directly.
