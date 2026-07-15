# KvK Tactical Name Refresh Design

**Status:** Approved. The user selected approach A: invalidate the idle tactical view when canonical display data changes while preserving the immutable snapshot of an already-fired rally.

## Goal

After a player changes Player ID or Nickname, every already-open page in the room must immediately show the same canonical display name in the personal chip, idle tactical timeline, radar, commander roster, and future rally selections.

## Reproduced defect

The defect is deterministic when only the display name changes:

1. Register `Ff` with a 34-second march.
2. Edit the same profile to `Kimchi` without changing the 34-second march.
3. Wait for the server acknowledgement and canonical room broadcast.

Observed on the editing page:

- local canonical profile: `Kimchi`, 34 seconds, revision incremented;
- personal chip: `You · Kimchi`;
- idle tactical timeline: `● Ff`.

A second page opened after the mutation immediately renders `Kimchi`. This proves that server persistence, acknowledgement, broadcast, and client profile adoption are correct. The stale value exists only in the already-open tactical view.

## Root cause

`mapData()` reads the current canonical name from `room.players`. `syncMap()` then computes an idle render key from only each actor's routing PID and march time. A name-only profile update keeps both values unchanged, so `syncMap()` returns before `renderRadar()` and `renderLanes()` run.

Existing identity tests did not catch the defect because every tested identity edit also changed march time, which accidentally changed the old render key.

## Chosen design

### Canonical idle render signature

Introduce a small `mapRenderKey(data)` helper. For an idle tactical view, it returns a deterministic JSON signature of every field that the idle map renders:

```js
function mapRenderKey(data) {
  if (data.live) return "live-" + data.id;
  return "idle-" + JSON.stringify(data.actors.map(function (actor) {
    return [actor.pid, actor.name || actor.pid, actor.march, actor.role, !!actor.mine];
  }));
}
```

`syncMap()` uses this helper instead of concatenating only PID and march. A canonical name change therefore triggers exactly one repaint on every open page. Stable snapshots retain the fast early return used by the 200 ms tick loop.

JSON serialization is used instead of a hand-written delimiter so names cannot create ambiguous signatures.

### Frozen live commands

A fired Double or Triple Rally continues to render the name, role, march, and timing captured in that command's persisted payload. Its render key remains `live-<command id>`.

This is intentional: editing a profile must not rewrite an in-flight command, restart its animation, or make the visual name disagree with the frozen countdown/delivery target. Idle views, staged selections, and later commands use the new canonical name.

### No protocol or data changes

The immutable routing PID, profile ownership, WebSocket messages, player records, march revision, staged selections, countdown targeting, and delivery acknowledgements remain unchanged. No migration or cleanup is required.

## Error and lifecycle behavior

- A failed or rejected identity edit leaves the canonical name unchanged, so the idle signature also remains unchanged.
- A successful edit repaints only after the canonical room snapshot arrives; no optimistic split view is introduced.
- Reconnect and refresh use the same canonical snapshot and signature.
- Language changes continue to invalidate the map through the existing language-render path.
- Name changes during a live command appear after that command ends or in the next command, without disturbing the current animation.

## Verification

1. A focused unit test proves that idle signatures differ when only `name` changes and remain identical for identical actor data.
2. The same unit test proves that a live command keeps the same key for the same command ID even if current profile data changes.
3. A browser regression opens an owner and observer before the edit, changes `Ff` to `Kimchi` with march fixed at 34 seconds, and verifies both tactical timelines, the personal chip, local profile, and commander roster show only `Kimchi` after settlement.
4. Existing identity, roster, Double Rally, Triple Rally, live-animation, delivery, update-floor, and multi-browser suites remain green.
5. The client build generation is advanced coherently so already-open older clients are forced onto the corrected assets.

## Risk

GitNexus rates `syncMap()` as HIGH impact because it is called by both the room-state path and the 200 ms animation tick and participates in three execution flows. The code change is intentionally confined to key generation; verification must cover idle repaint, unchanged-idle fast paths, and frozen live animation before deployment.

## Out of scope

- No change to rally timing, lead-time semantics, audio, or delivery guarantees.
- No change to server identity rules or room passwords.
- No attempt to rewrite names inside a rally that has already been fired.
