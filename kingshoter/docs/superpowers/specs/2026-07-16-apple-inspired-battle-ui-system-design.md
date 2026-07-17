# Apple-Inspired Battle UI System Design

**Status:** Approved.

**Relationship to the product design:** This document extends and constrains
`2026-07-16-rally-defense-separation-and-voice-defense-design.md`. The two
documents are one release contract. If an older KvK layout document conflicts
with this design, this document governs the new `/rally` and `/defense`
surfaces.

## Summary

Kingshoter will use Apple design principles as interaction and information
architecture rules, not as an iOS visual imitation. The existing mint, cream,
warm-brown palette, rounded typography, progress bars, and castle metaphor
remain recognizable. The redesign removes competing chrome, clarifies the
truth boundary of website delivery, makes every battle state predictable, and
adds a shared three-state mobile commander drawer.

The fixed information priority is:

```text
time and alert truth
  > the current player's action
  > team tactical state
  > manager operations
  > motion and decoration
```

The desired emotional rhythm is calm while waiting, focused when an order is
received, unmistakable at `Now`, and calm again immediately after completion or
cancellation.

## Sources and interpretation

The design is informed by:

- Emil Kowalski's Apple Design skill, especially response, direct manipulation,
  interruptibility, velocity handoff, spatial consistency, restrained
  materials, and reduced-motion behavior.
- Apple's *Designing Fluid Interfaces* guidance for 1:1 gesture tracking,
  presentation-value interruption, and velocity-aware settling.
- Apple's Human Interface Guidelines for hierarchy, layout, motion,
  accessibility, typography, feedback, and touch targets.
- Apple's principles of Purpose, Agency, Responsibility, Familiarity,
  Flexibility, Simplicity, Craft, and Delight.

These sources do **not** authorize full-page glass, decorative spring motion,
Apple branding, SF-only typography, Dynamic Island dependencies, or iOS-only
behavior. Kingshoter is a cross-platform web battle tool whose usefulness comes
from timing clarity and dependable state, not visual imitation.

## Global constraints

- Preserve the current rounded font stack and approximate player-name and time
  sizes. Do not shrink text to fit more controls.
- Preserve every selected captain's precise role progress bar. The castle map
  never replaces these bars.
- Mobile is primary. The canonical layout has no desktop-first left/right
  split. Desktop may widen management grids but keeps the same reading order.
- Ordinary Rally shows at most the six selected captains together. It never
  shows the complete room roster.
- Ordinary Defense rendering is constant-size regardless of whether a room has
  eight or one hundred registered defenders.
- Rally and Defense share UI components and browser foundations but keep their
  operational data, presence, commands, delivery, and audio routing isolated.
- The website receives no game telemetry. It may describe connection,
  scheduling, and website delivery; it may never claim a player reacted,
  joined a game rally, defended, marched, or arrived.
- Explicit user interaction remains required for browser audio enablement. The
  UI must not auto-click or simulate `Enable page alerts`.
- A manager-only device is not treated as a participant and remains silent.
- Every gesture has a visible button alternative.
- Inputs are at least 16px on mobile. Interactive hit regions are at least
  44 by 44 CSS pixels; primary battle actions are 48--62px high.
- Fixed QA room and password are both `qa`. The redesign is verified there
  before production promotion.

## Visual language

### Brand continuity

Keep the cozy mint/cream/brown character, rounded headings, soft radii, fish
identity, and restrained castle illustration. Do not replace the site with a
gray/blue Apple clone. The redesign changes hierarchy and behavior more than
brand identity.

### Semantic color tokens

Create a small semantic layer over the existing palette:

```text
label-primary       high-contrast warm ink
label-secondary     readable supporting copy
label-tertiary      decorative or nonessential text only
surface-base        opaque cream page
surface-raised      opaque paper card
surface-floating    translucent status/drawer chrome only
accent-action       sufficiently dark mint fill with readable foreground
accent-success      website-verifiable ready/scheduled state
accent-warning      recoverable audio/clock state
accent-danger       disconnected, destructive, or invalid state
accent-commander    authenticated manager controls
```

The existing `brown3` stays decorative and must not carry room state, role,
time, instructions, or interactive labels. Filled mint/green/coral controls use
deeper action colors or dark foregrounds so their text meets contrast
requirements.

### Type system

Use no more than four functional sizes on battle pages:

- personal countdown display: existing large responsive range;
- section/action title: approximately 16--18px;
- player name and primary row content: approximately 13--15px;
- supporting information: at least 11--12px.

Precise time values use tabular numerals and the existing mono stack. Tracking
is tightened only for large display text; body copy stays near normal tracking.
Important information is never reduced to 8--10px.

### Elevation and materials

Opaque surfaces contain forms, progress bars, tactical graphics, player lists,
and destructive confirmations. Translucency is limited to:

- the compact floating connection/alert strip;
- the commander drawer header;
- the sticky fire dock.

Never stack translucent cards. Provide solid fallbacks for reduced
transparency or unsupported `backdrop-filter`. Ordinary cards use fewer heavy
borders, gradients, and shadows so the personal countdown and primary action
are visually dominant.

## Shared battle shell

Both products use the same vertical shell and component rhythm:

```text
compact product/room identity
connection + alert truth + local clock
profile setup or collapsed You row
surface-specific personal/tactical content
collapsed manager-console entry
secondary alert settings and site navigation
```

Full site navigation is not a four-button block above live battle content.
During a room session it moves to a secondary menu/disclosure so tactical
content enters the first viewport. Language remains directly available but
uses a compliant touch target.

The ordinary page does not show total online count. Manager views may show
surface-specific connected and readiness counts because those numbers support
operations.

## Readiness and truth model

The shared status component renders one canonical readiness projection:

| State | Primary label | Meaning |
|---|---|---|
| ready | `Alerts ready · you can switch to the game` | explicit enablement, running audio, live carrier, connected socket, and fresh clock |
| audio recovery | `Tap to restore alerts` | the site cannot currently assert reliable audio scheduling |
| disconnected | `Connection lost · reconnecting` | socket or synchronized clock is not usable |
| not enabled | `Enable page alerts` | the browser still needs the user's gesture |
| manager-only | `Manager connected · clock synced` | management transport only; no personal audio claim |

Color always accompanies text and shape. A green state never claims speaker
volume, human attention, game action, march, or arrival. `Delivered / scheduled`
is reserved for a device acknowledgement that the order was received and its
future local cues were scheduled.

Before audio enablement, only actions that truly require audio are blocked.
The page is not globally grayscaled into looking broken. Manager-only access,
room navigation, help, profile inspection, and password entry remain usable.

## Rally ordinary-player page

### Waiting/setup order

After first setup, the visible order is:

1. readiness/clock strip;
2. collapsed `You · Name · march · Edit` row;
3. the two kingdom groups containing only staged or live captains;
4. all selected role progress bars and exact times;
5. the castle spatial field;
6. collapsed `Commander Console` entry.

Double shows up to four captains and Triple shows up to six. Both kingdoms stay
visible together. Five or six rows use a compact tactical density rather than a
kingdom tab, horizontal scroll, hidden rows, or smaller decision text.

### Personal action state

Only a player with a personal Rally target gets the large action countdown and
personal audio. An unselected ordinary member keeps the existing generic JOIN
policy and does not need vehicle assignment. An unselected commander receives
the silent launch monitor containing all selected captains. A commander who is
also a selected captain receives only that captain's personal audio.

### Tactical precision and spatial map

The progress bars and exact time labels are the authoritative tactical view.
The castle field explains relative distance.

For every idle or live projection:

```text
scaleMax = min(120, maxSelectedMarch * visualHeadroom)
visualHeadroom is chosen so the farthest point retains about 5--10% edge space
all point radii derive from the same scaleMax
the current scale is visible to the user
```

Do not round the scale up to a 30-second bucket that leaves much of the field
unused. Preserve relative player distances and a minimum separation from the
castle and from overlapping points. In a tie, use deterministic angular lanes
and subtle halos rather than altering the represented distance.

During the five-minute Rally gathering phase, player markers remain at their
departure radius and show only a compact gathering state. At march start they
move linearly toward the castle from absolute server time. Position updates do
not use a spring because spring overshoot would falsify timing. Completion may
use one short, nonlooping arrival emphasis.

## Three-state manager drawer

Rally Commander Console and Defense Manager share one bottom-drawer component:

```text
Closed  <->  Command  <->  Manage
```

### Entry and authentication

- Tapping the bottom console entry opens the password sheet if the current page
  session has not authenticated.
- Successful authentication is retained for the current page session.
- Collapsing is not logout and never clears the accepted password session.
- Reopening enters Command directly.
- Explicit logout is out of the primary flow and is not conflated with collapse.

### Gesture contract

- Dragging starts only from the drawer handle/header, so roster scrolling and
  sliders keep their native gestures.
- After an approximately 10px intent threshold, the drawer follows the pointer
  1:1 with pointer capture and respects the grab offset.
- Release selects a snap point from projected position and release velocity.
- The drawer uses a short, velocity-aware spring around response 0.3s with only
  slight momentum bounce. It can be grabbed and reversed before settling.
- Bounds rubber-band softly instead of freezing.
- Enter and exit follow the same vertical path.
- Reduced-motion uses a short fade/static snap and no large spring travel.

Visible alternatives always exist: `Close console`, `Players`/`Room` or
`Status`/`Players`, and `Back to command`.

### Command state

Command is a parallel, nonblocking layer: it does not scrim or replace the real
tactical page. The underlying page remains live and compresses only on the
authenticated manager's device.

Rally Command contains only kingdom, Double/Triple state, two or three staged
captain slots, readiness, lead time, double-tap Fire, and active-order Cancel.
The first Fire tap immediately renders `Armed · tap again`; the second matching
snapshot commits. Any selection/configuration change disarms it. Cancel removes
only the active Rally and preserves the staged team.

Defense Command contains the tap anchor, enemy march, a concise readiness
summary, one primary signal action, current expected impact/next wave while
active, and Cancel.

### Manage state

Manage is full-height and may lightly separate the battle page behind it. It is
the only place that contains complete rosters, detailed room state, profile
editing, removal, filters, and room settings.

Rally Manage has:

- `Players`: search, readiness, selected role, direct march editing, confirmed
  removal, and canonical conflict feedback;
- `Room`: both editable kingdom labels, each kingdom's independent
  Double/Triple setting, and the room link. Password changing is absent.

Defense Manage has exactly:

- `Status`: exception-first readiness and current-order aggregates;
- `Players`: virtualized search/filter/sort/detail/edit/remove management for up
  to 150 saved profiles and at least 100 connected devices.

## Defense ordinary-player page

The page mirrors Rally's shell but has no roster and no castle radar. The
defender enters Player ID or nickname, march time, explicitly enables/tests
alerts, and then sees only their profile, readiness, personal progress bar, and
waiting area.

For a captured valid order, the waiting area becomes the shared personal
countdown. It schedules T-15 preparation, T-10 through T-6 beeps, spoken 5
through 1, and `Now` at T0 using the exact same audio engine/assets as Rally. A
Too-late or newly registered profile receives no partial replay and waits for
the next round. Completion or cancellation automatically restores waiting
without clearing profile, march, or audio state.

## Feedback, error, and motion rules

- Every touch shows press feedback within 100ms; the action commits on release.
- Network actions keep their layout position and show pending state in place.
- Errors appear beside the control that caused them; toast is supplemental.
- Destructive player removal retains an explicit confirmation.
- Rally/Defense cancellation confirms only when needed and preserves all setup.
- Waiting pages contain no infinite decorative pulse or oscillation.
- `Now` may produce one synchronized visual/audio emphasis; it does not loop.
- Full-screen brightness flashes are removed or substantially bounded and have
  a reduced-motion/high-contrast alternative.
- Movement encodes real state only. Springs never determine countdown values,
  progress, marker distance, or order timing.

## Accessibility and platform support

- Use semantic `main`, `nav`, headings, dialogs, tablists, tabs, progressbars,
  and status live regions.
- `aria-current`, `aria-selected`, `aria-expanded`, `aria-controls`,
  `aria-valuemin/max/now`, and useful `aria-valuetext` match visible state.
- The countdown live region announces only T-15, 5, 4, 3, 2, 1, `Now`, and
  cancellation, never high-frequency timer paint.
- Keyboard, mouse, touch, and assistive-technology paths are equivalent.
- Focus remains visible and returns to the triggering control after dialogs.
- Status is never represented by color, opacity, or animation alone.
- Support 320, 375, 390, and 430px widths with no horizontal overflow or iOS
  focus zoom. Respect safe areas exactly once and prefer `100dvh` with fallback.
- Support `prefers-reduced-motion`, solid-surface fallback for reduced
  transparency, increased contrast, and forced-colors behavior where available.
- Android, iOS, macOS, and Windows receive the same truth labels even where
  browser lifecycle capabilities differ.

## Homepage, Codes, and Guide

The homepage keeps its current recognizable brand and font. The fish hero is
slightly shorter so two same-level cards, `Rally Coordination` and
`Defense Coordination`, are visible earlier. It remains a vertical mobile
layout.

Codes keeps its current purpose but uses compliant 44px copy controls, a polite
copy status region, and readable error/loading states. Guide keeps its visual
examples but increases meaningful SVG text to at least 11px and stops its
GSAP/requestAnimationFrame loops under reduced motion.

These supporting pages share the semantic colors, type scale, touch rules,
safe-area treatment, build ID, and secondary navigation without importing
battle-only controllers.

## Code organization

The implementation remains vanilla JavaScript and follows the existing
UMD/CommonJS-compatible testing pattern. Shared UI responsibilities are split
by behavior:

```text
public/battle-ui.css       semantic tokens, base type, shared components,
                           accessibility and responsive contracts
public/battle-drawer.js    three-state pointer/keyboard drawer state machine
public/battle-status.js    canonical readiness/truth projection and labels
public/rally.css           Rally-only tactical and command presentation
public/defense.css         Defense-only personal and manager presentation
```

Tactical geometry belongs in the Rally domain/projection rather than CSS or the
drawer. Defense virtualization remains a focused module. Shared UI modules do
not inspect Rally commands or Defense orders.

The current monolithic `app.css` is migrated incrementally into
tokens -> base -> shared components -> page components -> responsive rules.
Duplicated late overrides and inline styles are removed only after focused
tests prove equivalent or intentionally changed behavior. All first-party
pages use one coherent release build ID.

## Performance and persistence rules

- UI animation runs on compositor-friendly transform/opacity paths.
- Countdown and tactical paint derive from absolute time in each browser; the
  server never emits per-second countdown frames.
- Drawer motion does not cause room persistence or WebSocket status writes.
- Repeated identical device readiness frames are ignored before persistence and
  broadcast.
- Heartbeats refresh transient presence without rewriting unchanged canonical
  room state.
- One hundred idle connected Defense sockets produce no periodic canonical
  storage writes solely for UI/readiness animation.
- Virtualized manager lists keep a bounded DOM node count.

## Validation

### Component and unit checks

- readiness labels and status truth;
- drawer state, intent threshold, interruption, velocity projection, snap
  points, button alternatives, and reduced-motion mode;
- tactical scale uses the current real maximum with edge headroom;
- gathering markers stay at departure radius and march markers use absolute
  linear progress;
- semantic color contrast, minimum type sizes, and 44px hit regions;
- Fire arming/disarming, cancel preservation, authentication retention;
- semantic roles/live-region cadence and escape/truncation behavior.

### Browser checks

- ordinary Rally at Double/Triple with 2--6 selected captains;
- Rally commander-only, commander+captain, Command and Manage states;
- ordinary Defense waiting/active/Too-late/repeated rounds;
- Defense manager-only and manager+defender;
- 320/375/390/430 widths, long English/Chinese names, keyboard navigation,
  reduced motion, high contrast, no focus zoom, and no horizontal overflow;
- Homepage, Codes, and Guide consistency.

### Release checks

- UI and Rally/Defense isolation ship as one QA-tested release;
- QA uses only room/password `qa`;
- production smoke checks do not mutate operational rooms;
- no regressions in Double/Triple personal timing, audio, cancel/restage,
  reconnect, clock drift, or silent commander behavior;
- the exact QA-tested commit is promoted atomically with a recorded rollback
  version.

## Acceptance criteria

- The first ordinary-player viewport is dominated by current battle content,
  not site navigation or management controls.
- All selected Rally captains and exact progress bars remain visible; the map
  fills its existing frame while preserving real relative distance.
- The map does not move markers toward the castle during gathering.
- The manager drawer supports Closed, Command, and Manage with direct,
  interruptible touch behavior and visible non-gesture alternatives.
- Collapsing a manager drawer does not require password re-entry on reopen.
- Ordinary pages show no complete roster or irrelevant online total.
- Manager-only devices stay silent and do not show a personal-audio error.
- Defense supports large rosters through Status aggregation and virtualized
  Players without changing ordinary-page height.
- All readiness and delivery language stays inside the website-verifiable truth
  boundary.
- Text, contrast, touch size, semantics, reduced motion, and safe-area behavior
  meet the explicit contracts above.
- Shared visual and interaction modules serve both Rally and Defense; neither
  product contains a forked audio, countdown, profile, drawer, or status system.
- Full local, browser, scale, QA, and device gates pass before production
  promotion.
