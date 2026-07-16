# KvK Adaptive Battlefield Scale Design

**Status:** Approved through the user's requested behavior.

## Goal

Use the full existing castle battlefield without changing its outer size. Player distance from the castle remains proportional to canonical march time, while the visible scale adapts to the longest currently selected captain.

## Behavior

- Keep the current battlefield dimensions, castle size, kingdom rays, routes, dots, typography, and `ringR()` geometry.
- With selected captains, choose an idle spatial domain of 30, 60, 90, or 120 seconds by rounding the longest canonical march time up to the next 30-second boundary.
- Clamp the idle domain to the existing two-minute maximum. An empty battlefield retains the 120-second default.
- The same chosen domain drives every selected captain, so relative distances remain truthful. For example, captains at 13–40 seconds use a 60-second battlefield instead of a 120-second battlefield.
- Do not change the timeline's fixed two-minute scale, live-command snapshots, rally timing, countdowns, audio, room state, or delivery behavior.

## Verification

- Unit-test the empty state and the 30/60/90/120-second boundaries, including values above 120 seconds.
- Run the complete source test suite and the existing mobile tactical browser scenario.
- Visually verify a room with 13-, 34-, 36-, and 40-second captains at supported mobile widths.

