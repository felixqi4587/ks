# KvK Mobile Homepage Conservative Layout Design

**Status:** Approved. This specification covers only the ordinary-player Attack homepage and the same homepage while the Commander Console is closed.

## Goal

Make the existing mobile homepage easier to read when two kingdoms stage up to three rally captains each, while preserving the current visual language. The role timeline remains the primary information surface. The lower castle battlefield becomes moderately taller and spatially meaningful, but the castle itself does not become the main visual.

## Approved visual direction

The existing page remains recognizable:

- Keep the current rounded font stack (`var(--font)`) and monospaced time stack (`var(--mono)`).
- Keep player names at `13px/800`, the current player at `13px/900`, times at `15px/900`, timeline tracks at `30px`, idle dots at `16px`, and travelling dots at `17px`.
- Keep the existing status chrome, personal player chip, Attack/Defense switch, card styling, colors, and Commander Console entry.
- Do not introduce the prototype's `system-ui`, `font-weight:950`, or smaller 320px typography.
- On narrow screens, recover width by changing only the lane columns and gaps: the normal `84px / 1fr / 56px` layout may become `76px / 1fr / 48px` with a `6px` gap. Core text and progress-bar sizes remain unchanged.

## Selected-captain timeline

### Canonical source

When no rally command is active, the homepage uses the canonical staged selections in `room.live.staged[1]` and `room.live.staged[2]`. It no longer renders every registered room player.

The staged records are authoritative for membership and role only. Display name and march time come from the current canonical `room.players[pid]` record, so a commander name/time edit repaints every open page without restaging the captain.

- Only players already selected into a kingdom's rally queue appear.
- A kingdom may show two Double captains or three Triple captains.
- The maximum is six rows: three for Kingdom 1 and three for Kingdom 2.
- Registered but unselected players remain available in Commander management but do not consume homepage space.
- The page uses only server-confirmed room state; it does not expose one commander's private optimistic selection to other devices.
- Missing or malformed staged references fail closed and do not produce placeholder players.

### Grouping and order

Selected captains are grouped by kingdom in one tactical card. Each non-empty group has a compact localized header containing the existing kingdom label, the existing localized Double/Triple label, and `selected/required` count.

Within each group, rows use canonical role order:

1. Sacrifice 1 (`weak`)
2. Sacrifice 2 (`weak2`, Triple only)
3. Main (`main`)

The visible name column continues to show the player's name only. It does not append `S1`, `S2`, or `Main`, because long names must truncate rather than force a smaller font or steal progress-bar width. Existing role classes and accessible labels continue to carry role semantics.

No `+N` overflow row is allowed. The canonical queue already limits the tactical homepage to six selected captains.

### Timeline scale

The idle timeline remains fixed at `0–2:00`:

- One marker position and the right-side time use the same canonical `march` value.
- The track shows four equal 30-second regions, with separators at 25%, 50%, and 75%.
- Existing end padding remains so the 120-second marker is fully visible.
- The timeline is not replaced by a plain time label on any supported mobile width.

### Active rally guardrail

An active rally continues to use the existing `activeCommand()` choice and the command's immutable pair snapshot. This iteration does not combine two live commands or change which personal command the page follows. The selected command may receive a kingdom header, but its name, role, march, press time, gather time, landing time, countdown, and animation remain frozen to the command payload.

## Castle battlefield

The battlefield is enlarged through layout and geometry, not through typography or castle scale.

- At widths above 360px, the battlefield is approximately `270px` tall.
- At widths of 360px and below, it is approximately `258px` tall.
- The SVG view box grows with the field so the extra height is real layout space rather than a stretched picture.
- `window.ksCastle()` remains unchanged; its `40px × 32px` body and existing merlons are retained.
- The castle stays centered horizontally near the upper part of the field.
- Captain dots spread along stable kingdom/role rays. Kingdom 1 occupies the left fan and Kingdom 2 the right fan.
- Dot distance is computed from the same canonical march value used by the timeline. Longer marches are farther from the castle; the closest dot remains visibly separated from it.
- Subtle dashed routes connect each captain to the castle so the spatial view communicates movement rather than decoration.
- During a live command, the existing `press → land` clock continues moving each dot inward on its own route. Timeline and radar remain driven by the same actor data and clock.
- The farthest complete dot keeps at least a small visual inset from the field edge and is not clipped.

## Responsive behavior

The page keeps one vertical document scroller and no horizontal or nested scrolling.

Required widths:

- `320px`
- `375px`
- `390px`
- `430px`

At every width:

- `document.documentElement.scrollWidth === window.innerWidth`.
- The tactical card, lanes, rows, and battlefield do not overflow horizontally.
- All six selected rows can be read before the battlefield; the battlefield may continue below the first viewport on shorter phones.
- Long names remain a single ellipsized line.
- The progress track stays `30px` high and retains a useful width.
- Safe-area padding and the existing whole-page vertical scrolling remain intact.

## State and update behavior

- A canonical stage update repaints all open room pages through the existing `onState() → syncMap()` path.
- Player name or march changes repaint staged idle rows because the idle render key includes all displayed canonical fields, kingdom, role, and rally mode.
- A live command render key remains command-ID based so profile edits cannot rewrite an in-flight rally.
- Removing or reassigning a staged player updates all open pages from the next canonical state.
- Empty staged state shows the existing battlefield empty treatment with wording that indicates the commander has not selected rally captains yet.

## Accessibility and motion

- Existing semantic buttons and navigation remain unchanged.
- Kingdom headings are real text, not color-only grouping.
- Color may reinforce kingdoms, but names, order, and headers remain sufficient without color.
- Existing reduced-motion behavior is retained.
- The castle and player markers remain decorative supplements to the timeline; users never need to infer an exact number from spatial position alone.

## Risk containment

GitNexus reports HIGH risk for `mapData`, `renderRadar`, `renderLanes`, and `mapRenderKey`, and CRITICAL risk for `ringR`, because the chain is called from both `tick()` and `onState()` and participates in `syncMap()` and `wireRoom()` flows. The direct caller set is small, so implementation stays inside this tactical projection and rendering chain.

Required protection:

- Focused unit tests for canonical staged projection, kingdom/role ordering, the six-row cap, idle render-key invalidation, fixed 120-second domain, and frozen live command projection.
- Browser tests in isolated generated `qa-kvk-*` rooms for six selected captains, two kingdom headers, unselected-player exclusion, exact typography, progress-bar dimensions, battlefield height, castle size, and horizontal overflow.
- Regression coverage for active Double/Triple rendering and the existing countdown/audio/delivery suites.

## Out of scope

- Commander drawer, Commander collapse gestures, full-screen Players, or Room management.
- Moving online counts or changing the meaning of the connection/audio readiness lights.
- Editable kingdom names.
- Defense-page redesign.
- Changes to rally timing, lead time, voice/audio, Fire, delivery acknowledgement, WebSocket, persistence, passwords, or room security.
- Showing two simultaneous active commands in one live timeline.
- Deployment to production; this design is first implemented and verified locally.
