# KvK Commander Launch Monitor Design

**Status:** Approved.

## Goal

Stop showing a non-participating commander one captain's personal hourglass. Instead, give that commander a silent overview of every live rally captain's launch time.

## Audience behavior

- A selected captain who also unlocked Commander mode keeps the existing personal hero, personal countdown, voice, beeps, vibration, and GO flash.
- A commander device that is not selected in any live rally hides the personal hero and shows the Commander Launch Monitor.
- An ordinary non-commander member keeps the existing shared JOIN countdown and JOIN audio.
- A non-participating commander receives no rally voice, beeps, vibration, GO flash, or JOIN cue. Existing cue routing remains the authority and must stay unchanged.

## Launch monitor

- Read immutable captain names, roles, kingdoms, and `pressUTC` values from every live Double or Triple command snapshot; do not add server state or infer from the current roster.
- Combine both kingdoms and sort all valid captains by `pressUTC`, then kingdom and role for stable ties. Render at most six rows.
- Each compact row shows kingdom, captain name, role, and the remaining launch time. Highlight only the next future launch; apply urgency color at ten seconds or less; show `Opened` / `已开车` after the launch second.
- The monitor replaces the giant hero only on non-participating commander devices. It sits in the same area above the tactical timeline. Earlier captains remain marked as opened while a later captain is still pending; the monitor hides three seconds after the final captain's launch second instead of occupying the screen for the command's full flight.
- Countdown updates use `window.serverNowSec()` and the same frozen `pressUTC` timestamps as personal countdowns. The tactical timeline/radar, command selection, countdown calculations, and backend protocol do not change.

## Responsive and accessibility

- Use one vertical list at mobile widths; no horizontal scrolling and no font reductions to the existing tactical timeline.
- Use a labelled section and text labels in addition to color. Do not use an `aria-live` countdown that would announce every second.
- Long names truncate on one line; all tap targets and Commander controls remain unchanged because the monitor is read-only.

## Verification

- Unit-test two simultaneous commands containing Double and Triple captains, stable ordering, malformed-pair rejection, six-row cap, next/urgent/opened states, and escaped names.
- Browser-test four identities: unselected commander, selected commander, ordinary member, and selected captain. Confirm their respective monitor/hero visibility and cue keys.
- Verify 320, 390, and 430 pixel widths, no horizontal overflow, no page errors, and unchanged existing audio/cue tests.
