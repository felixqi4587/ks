# kvk.html situation-first redesign — design

## Problem

Real screenshots of the live page (idle player state + commander-unlocked state) confirmed every complaint:

- `openCmd()` sets `radarFold.open = false` — the radar auto-collapses exactly when the commander unlocks and needs it most.
- The idle "You're set ✓" card (`.phero.idle.ready`) reuses the same large hero template as the live countdown (big padding, big checkmark) but carries almost no information — it is the single largest element on screen while idle.
- The sticky chrome bar renders four separate concepts as four separate text fragments: `Connected ✓ synced 1 here HH:MM:SS`.
- After unlocking, the commander console sits at the very bottom of a long stack (chrome → fill/you card → phero → timeline → radar → settings → console) — the most important controls require the most scrolling.
- Commander-console labels are full instructional sentences (`① Target kingdom (counter = the other one)`) repeated on every visit, duplicating what the one-time driver.js tour already teaches.

## Decisions (confirmed with user)

1. Implement directly in `kvk.html` / `kvk.js` / `app.css` — no Claude Design / DesignSync involvement. Confirmed not applicable: DesignSync's `/design-sync` companion skill converts a Storybook/npm component-library repo into design-agent assets; kingshoter is an unbuilt static HTML/CSS/JS site with no component library.
2. Layout order after commander unlock is **situation-first**: status → situation (radar+timeline) → console → your status line → settings. The commander sees the shared situation view, then acts, with no scrolling.

## Design

### 1. Chrome status bar — one signal, not four
Collapse `#cdot` + `#netlab` + `#syncbadge` + `#presence` into one dot + one label, worst-state-wins:
- not connected → red dot, "reconnecting"
- connected, not clock-synced → amber/neutral dot, "syncing"
- connected + synced → green dot, "{n} online"
The clock (`#utc`) stays, small, top-right corner, unchanged.

### 2. Situation block — radar + timeline merged, always expanded
Remove the `<details id="radarFold">` wrapper entirely (and its `summary` header). Radar (small glance strip) and timeline (`#lanes`) live inside one bordered card, timeline on top, radar below, exactly like today's visual order — just no fold, ever. `openCmd()` no longer touches radar open/closed state (that state stops existing). This permanently fixes the "important map gets hidden" complaint — there is nothing left to accidentally collapse.

### 3. Delete the idle "You're set" hero; `#phero` only renders when time-sensitive
`#phero` stops rendering anything for the plain idle case (no active/staged command) and for the stale/finished case — it is hidden (`display:none`) instead of showing a large empty card. The already-existing `youChip` (one line: name · march time · Edit) continues to carry "you're set" information at idle. `#phero` reappears (and takes the big hero treatment) only for:
- `stagedForMe()` (picked as captain, about to fire)
- an active/live command (existing full countdown, refill, sound-check)
The `needsteps` messaging ("① turn on sound ② enter march") is deleted — it duplicated the existing dim/lock treatment (`#roomView.presound`) and the still-open fill card, which already communicate what's missing.

### 4. Reordered DOM after unlock
`chrome → situation (radar+timeline) → console (if unlocked, else the quiet "I'm the commander" link) → your status line (youChip, or the fill card while unfilled) → settings (folded) → footer`.
The console is the second thing on screen once unlocked, not the last.

### 5. Trim commander-console copy
`cstep1/2/3` shrink from full instructional sentences to short labels (e.g. "Target kingdom", "Pick 2 captains", "Lead time"). The nuance they currently spell out ("counter = the other kingdom", "tap badge to swap main/sacrifice") is exactly what `startCmdTour()`'s driver.js steps already teach on first unlock — no need to print it permanently.

### 6. Unchanged
animal-island CSS variables/palette, double-tap-to-confirm fire button, numberless radar dots, absolute landing-clock timeline, auto-ready (`isReady()`/`#syncPill`), background audio engine, all i18n infrastructure (`KT`/`tk`/`tkf`).

## Scope / risk

Frontend-only change across `kvk.html`, `kvk.js`, `app.css`. No backend/Worker/Durable-Object change. Existing Playwright suites (`rebuild.cjs`, `redesign.cjs`, `ready.cjs`, `bg.cjs`, `v8.cjs`, `multikingdom.cjs`, `final2.cjs`) assert on some of the DOM/text being removed or restructured here (e.g. `#radarFold` open/closed state, chrome text fragments, `phero` idle class) and will need updating alongside the implementation, plus one new check that the situation block stays expanded after commander unlock.
