# KvK Reliable Shadow QA

Reliable Shadow is a hidden QA candidate, not a player feature. Classic remains the only audio authority. The candidate records whether it *would* schedule a cue and whether its protocol was acknowledged; it never plays sound, changes a Classic countdown, or proves that a person heard an alert.

Playwright Chromium, Firefox, and WebKit are desktop browser tests. In particular, Playwright WebKit is not evidence from an iPhone or iPad. Do not claim guaranteed delivery from an ACK, a green indicator, desktop automation, or one successful physical-device run.

## Hard room boundary

Every mutation in this runbook must use a newly generated lowercase room beginning with `qa-kvk-`. Never reuse a QA room. Never use room `1406`, another named alliance/kingdom room, a demo room, or any operation room.

Generate a room for a manual run:

```bash
cd "$KVK_WORKTREE/kingshoter"
node -e "const h=require('./test/support/qa-kvk.cjs'); console.log(h.makeQaRoom({title:'manual-reliable',project:{name:'manual'},workerIndex:0,retry:0,repeatEachIndex:0}))"
```

The command must print one `qa-kvk-*` value no longer than 48 characters. The automated suite generates its own unique rooms and refuses a non-QA room before opening a connection.

## Local automated gate

Run the complete local gate from the app directory:

```bash
cd "$KVK_WORKTREE/kingshoter"
npm test
npm run test:delivery
npx playwright install chromium firefox webkit
npm run test:qa:delivery
```

Every command must exit with status 0. The final Playwright command must report nine passing tests: topology, reconnect, and Classic rollback in each of desktop Chromium, Firefox, and WebKit.

This gate covers protocol routing, immutable retries, per-device isolation, cancellation, reconnect, aggregate-only public evidence, commander audience rules, and a Classic-only rollback. It does not prove mobile background survival, operating-system notification delivery, or that a human heard sound.

For a quicker local Chromium-only diagnostic, use:

```bash
npm run test:qa:delivery:chromium
```

That shortcut does not replace the three-browser gate.

## Shadow enablement and Classic rollback

Reliable Shadow starts only when the URL contains both exact gates once:

```text
deliveryQa=1&deliveryShadow=1
```

The room must also be a generated `qa-kvk-*` room. Missing either gate keeps the browser on Classic only.

The rollback is therefore to omit **both** `deliveryQa=1` and `deliveryShadow=1`. No room migration is required. The rollback acceptance test must still observe the selected captains' personal Classic countdowns and the ordinary member's generic join countdown, with:

- no `deliveryShadow*` client or server frames;
- no candidate controller on `window.__kvkDeliveryQa`;
- no public `deliveryShadow` summary.

Classic remains the default before, during, and after this evaluation. Do not add a permanent player-facing selector or a backup-alert warning. Keep the product surface small unless physical evidence shows a clear improvement.

## Explicit production-connected QA gate

Do not run production-connected QA during normal implementation. It requires explicit operator authorization after every local gate is green. The only approved command is:

```bash
cd "$KVK_WORKTREE/kingshoter"
QA_BASE_URL=https://kingshoter.com ALLOW_PRODUCTION_QA=1 npm run test:qa:delivery
```

The harness still generates fresh `qa-kvk-*` rooms and random QA-only credentials. Its configuration rejects unknown origins, credentials in the URL, paths, queries, fragments, and nonstandard ports; it also rejects the exact production origin unless `ALLOW_PRODUCTION_QA=1` is present. Authorization never permits room `1406` or any other operation room.

## Physical iOS and Android trials

Physical testing is a separate, manual evidence gate. Test current supported iOS/iPadOS Safari and Android Chrome on real devices. Record exact OS, browser, and hardware versions; do not substitute desktop emulation.

For each run:

1. Obtain explicit authorization for production-connected physical QA.
2. Generate a new `qa-kvk-*` room and a random password used only for that room.
3. Open the same generated room on every device with both exact gates, for example:

   ```text
   https://kingshoter.com/kvk.html?room={generated-room}&deliveryQa=1&deliveryShadow=1
   ```

4. Use the existing user gesture to enable sound. Confirm Classic is armed before backgrounding anything.
5. Use one commander-only device, two selected captain devices, and one ordinary member device. If the commander is not selected as a captain, it must not receive rally audio.
6. Issue the server command only after the target device is in the state being tested. Do not use a locally pre-scheduled timer as a substitute.
7. Exercise supported lead values `10`, `15`, `30`, and `60` seconds. Record the immutable command ID and target times.
8. Verify one personal Classic countdown per selected captain, one generic join countdown for the ordinary member, and no rally audio for the unselected commander.
9. Cancel a second 15-second order before GO and verify that no future cue remains.
10. Disconnect one selected device, issue a 15-second order, reconnect before expiry, and record whether the original command ID returns without moving GO.
11. Repeat the core case with both shadow gates omitted and verify that Classic still works with zero candidate traffic.

Run separate `5`, `15`, `60`, and `180` minute trials for every physical platform/capability group. At each duration cover, where the OS permits:

- foreground browser;
- background tab with Kingshot in the foreground;
- screen locked;
- offline then online;
- call or audio-focus interruption;
- Bluetooth route change;
- battery saver or low-power mode;
- memory pressure or browser process restart;
- whole-device sleep.

Operating-system suspension, process termination, and whole-device sleep are recorded as unsupported for live timing whenever delivery fails. A failed state must not be relabeled as a success or inferred from a later reconnect.

## Evidence record

Record one row per device and command. Store only QA identifiers; do not record a full user agent or production player data.

| Field | Required value |
|---|---|
| `runId` | Random QA run identifier |
| `durationMinutes` | Exactly `5`, `15`, `60`, or `180` |
| `room` | Fresh generated `qa-kvk-*` room |
| `commandId` | Exact immutable server command ID |
| `platform` | OS name and exact version |
| `browser` | Browser name and exact version |
| `hardware` | Device model or desktop hardware class |
| `deviceId` | Random QA device ID; never a full user agent |
| `view` | `player` or `commander` |
| `selectedRole` | `weak`, `main`, or `none` |
| `visibility` | `foreground`, `background`, `locked`, `kingshot_foreground`, or `restarted` |
| `interruption` | `none`, `offline_online`, `call`, `bluetooth`, `battery_saver`, `memory_pressure`, or `sleep` |
| `soundArmedAtStart` | `yes` or `no`, based on the Classic sound state before the trial |
| `issuedAtMs` | Server issue timestamp |
| `fireAtMs` | Immutable target timestamp |
| `classicScheduledAtMs` | Timestamp or `absent` |
| `classicFutureCueCount` | Integer from `0` through `12` |
| `candidateResult` | `would_schedule`, `audio_unarmed`, `expired`, `duplicate`, or `absent` |
| `candidateAckAtMs` | Timestamp or `absent` |
| `retryCount` | Non-negative integer |
| `humanObserved` | `yes`, `no`, or `unknown` |
| `observedGoDeltaMs` | Measured difference from GO or `unknown` |
| `batteryDataNotes` | Battery, heat, data use, audio focus, and anomalies |

An ACK means only that the candidate protocol reached and was handled by that browser context. `humanObserved=yes` requires a person to observe the expected Classic cue on that physical device. Keep the two facts separate.

## Decision and rollback rule

Reliable Shadow remains hidden unless repeatable physical evidence across supported capability groups shows a material receipt improvement, timing no worse than Classic, no duplicate or stale GO, acceptable battery/data/maintenance cost, and a simpler operational result. Missing evidence counts as missing, not passing.

If those conditions are not met, keep Classic and omit both gates. Remove only candidate-specific browser/evidence code if necessary; retain shared server delivery foundations that other KvK features depend on unless those features are first refactored away from them. Never describe the current system as guaranteed delivery.
