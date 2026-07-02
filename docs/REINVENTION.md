# SA50 RTS Ready → "Shift OS" — Redevelopment Blueprint

The next iteration turns a shared shelf-life calculator into a **personal, connected
operating system for the RTS shift**. It is an *evolution, not a rewrite*: same fast
vanilla PWA + Firebase live sync — we grow the data model, not the tech stack.

## Guiding principles
- **Keep it fast.** No framework. Lazy-load heavy things (feed, photos). Offline-tolerant.
- **Brand core, personal accent.** H-E-B red stays the chrome; each person's color is an accent only.
- **Identity is the keystone.** Everything below stands on knowing *who you are*.
- **Async by design.** RTS staff are staggered — never two at once — so the tool is the handoff.
- **Everything syncs.** One shared source of truth across all phones.

---

## Pillar 1 — Identity & personalization (foundation)
- **Personal PIN per person.** The lock screen becomes "enter *your* PIN" and resolves to *you*
  (replaces the shared 1905 gate). Self-serve: "New here? Create your profile."
- **Profile** = name + emoji avatar + accent color + personal PIN.
- **Accent-only theming:** your color appears on your greeting ("Howdy, Tomás"), your avatar,
  your feed posts, and your check-marks/progress — red stays the brand.
- Device remembers the last profile; quick-switch for shared phones.

## Pillar 2 — Attribution (accountability, for free)
Once the app knows who you are, actions get stamped automatically:
- Floor Log photos auto-tag your name (drop the manual initials field).
- Pull list / Freezer Mode record who set the floor.
- Production records who made what.
This data powers both the feed's auto-posts and the personal stats later.

## Pillar 3 — The Shift Feed (solves the communication pain)
An async team board — the standup you read whenever you clock in. Newest first, each post
wears the author's color + avatar.
- **Heads-up** — "low on brioche, put in an order."
- **Handoff** — "floor's set, holes in table 4 need filling next shift." (Shown to the next
  person on entry: "Last shift left you…")
- **Props / kudos** — tag a teammate.
- **Auto-posts** — the app narrates wins: "Tomás pulled 14 items · set the floor 1:40p."
- **Reactions** (👍❤️🔥👏) for typing-free acknowledgment, plus optional **photo attach**
  (reuses the Floor Log camera pipeline).
- Team-visible board (no private 1:1 DMs to start — keeps it simple and honest).

## Pillar 4 — Productivity manager (the payoff layer)
- **"Your Day"** recap: items pulled, platters made, holes filled, photos logged, kudos received.
- **Team dashboard:** who's active, recent activity, open handoffs & holes to clear.
- **Recognition:** kudos tallies, streaks, weekly shout-out.
- **Tasks:** claimable to-dos ("fill holes table 4," "prep X") — assigned or open.

---

## Data model (Firebase)
```
users/{uid}         profile: { name, emoji, color, pin, role?, createdAt }
feed/{postId}       { uid, type, text, photo?, ts, reactions{}, tags[] }
handoff/current     latest floor-state note for the next shift
rts/cust rts/pull rts/prod rts/compBox rts/log      (existing)
```
Local (per device): which profile is "you", accent color cache.

## Security note
PINs remain casual gates (as today) — fine for an internal tool. Feed posts are visible to the
whole team by design. Keep images compressed; nothing sensitive stored.

---

## Phased roadmap (each phase ships usable on its own)
- **Phase 1 — Identity & personalization**
  Profiles, personal-PIN login, self-serve profile creation, accent theming, header avatar/greeting,
  and wire `currentUser` into Floor Log (auto name) + a "set by" stamp on pulls.
- **Phase 2 — Shift Feed**
  Feed view, post types (heads-up / handoff / props / auto), reactions, photo attach, auto-posts,
  and the "last shift left you" handoff card on entry.
- **Phase 3 — Productivity**
  Your Day recap, team dashboard, recognition/streaks, claimable tasks.

## Open decisions
- Profile creation: self-serve vs. pre-seeded roster (+ who can remove people).
- Forgot-PIN handling (master reset PIN?).
- Auto-post tone/opt-out.
- Feed retention (keep all vs. rolling window).
