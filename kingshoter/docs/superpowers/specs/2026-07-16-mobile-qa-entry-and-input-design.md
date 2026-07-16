# Mobile QA Entry And Input Design

## Goal

Provide one production-safe phone test path:

- Open `https://kingshoter-qa.kingshot1406.workers.dev/kvk`.
- Enter room name `qa` and continue into the existing room.
- Use commander password `qa` when commander access is needed.
- Focusing room, identity, password, search, or other editable fields must not make iOS Safari zoom the page.

Production deployment, routes, rooms, and data remain untouched.

## Existing behavior and root cause

The no-query KvK page already contains the correct room-search gate and sanitizes a submitted room name before navigating to `kvk.html?room=<name>`. No new room system or alternate QA URL is needed.

The mobile zoom is caused by editable controls whose computed font size is below 16 CSS pixels. The current room, identity, and password inputs compute to 15px; some roster inputs compute to 14px and textareas to 13.5px. iOS Safari may automatically zoom those controls on focus.

## Selected design

1. Keep the existing no-query `/kvk` room-entry flow. The stable user-facing test value is exactly `qa`.
2. Add a KvK mobile media rule at widths up to 820px that gives editable `input`, `select`, and `textarea` controls a minimum effective size of 16px.
3. Exclude range, checkbox, and radio controls because they are not text-entry fields.
4. Preserve the existing 20px sizing of march-time text inputs so the change does not shrink prominent controls.
5. Do not add `user-scalable=no` or reduce `maximum-scale`; user pinch zoom remains available.
6. Advance the required KvK build from `2026071506` to `2026071507` so already-open older clients are forced through the existing update flow and do not retain stale CSS.

The mobile rule changes only input text, not the established page typography, card layout, headings, or tactical panel.

## Verification

- A focused automated computed-style test checks 390px mobile and desktop widths.
- On mobile, room name, Player ID/nickname, commander password, roster search, textarea, and regular select controls compute to at least 16px.
- March-time text controls remain 20px, while non-text range/checkbox/radio controls are not affected.
- The QA Worker is deployed only through `wrangler.qa.toml`.
- The live no-query `/kvk` page accepts `qa`, enters the fixed `qa` room, unlocks with `qa`, and has no horizontal overflow.
- The existing `qa` room lineup and state survive the deployment unchanged.

## Rollback

The change is isolated in one mobile CSS rule plus a coherent build-number bump. Rollback is the prior QA Worker deployment/version; production is never modified.
