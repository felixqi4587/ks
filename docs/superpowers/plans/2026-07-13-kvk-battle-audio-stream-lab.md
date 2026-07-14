# KvK Battle Audio Stream Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hidden, opt-in Battle Audio Stream lab that tests whether one explicitly started continuous media stream delivers server-injected personal KvK countdowns more reliably in the background than Classic, without changing Classic or exposing the experiment to ordinary users.

**Architecture:** Add one isolated `AudioStreamLab` Durable Object behind fail-closed `/api/lab/audio-stream/*` routes and one unlinked `/lab/audio-stream.html` page. A native `<audio>` element consumes a continuous 48 kbps CBR MP3 response; the Durable Object, not page JavaScript, substitutes selected-player countdown frames into that response from server-owned absolute times. The lab has private QA sessions, bounded jobs, streams, metadata, and evidence. It never writes `Room`, never sends a production delivery ACK, never imports Classic audio scheduling, and can be stopped or deleted independently.

**Tech Stack:** Cloudflare Workers, SQLite-backed Durable Objects, Worker alarms, streaming `ReadableStream` responses, native HTML media and Media Session APIs, vanilla JavaScript, deterministic FFmpeg 8.x MP3 assets, Node `node:test`, Playwright, Wrangler 4.110.0.

## Global Constraints

- Complete Core, Reliable, Triple, and the serial Push-plan shared-file reconciliation first. This plan consumes their shared QA helper, room-local device identity, QA validator, `weak2` role, and immutable timing facts unchanged; it must preserve Push additions to `worker.js`, `wrangler.toml`, and `package.json`.
- `test/support/qa-kvk.cjs` must already export exactly `assertQaRoomName(room)`, `makeQaRoom(testInfo)`, `qaRoomUrl(baseURL, room, params = {})`, and `installQaWebSocketGuard(context, room, options = {})`. The only supported fault hooks are `shouldDropClientMessage({ url, data })` and `shouldDropServerMessage({ url, data })`. Do not recreate, broaden, or overwrite this helper.
- `src/delivery.js` must already export `isQaRoomName(room)`. Server lab routing imports that exact function; there is no second server-side room-name policy and no exception for room `1406`.
- `public/app.js` must already expose `window.getRoomDeviceId(room)`. The hidden page loads that existing script and uses the same room-local ID. Do not create another device key or generator.
- Classic remains the only production audio authority and rollback path. Do not modify `src/room.js`, `src/delivery.js`, `public/kvk.js`, `public/kvk.html`, `public/app.js`, `public/app.css`, the shared QA helper, or the room harness in this plan.
- Do not add a link, prompt, badge, warning, status, media-session registration, mode selector, or candidate script to any ordinary-user page. Ordinary KvK with no lab URL is byte-for-byte behaviorally unchanged whether this lab is enabled, disabled, broken, killed, or deleted.
- The lab produces synthetic QA commands only. It does not listen to operational Fire, mirror a live room, mutate a core command, influence Classic scheduling, or claim that a stream receipt means a player heard audio.
- The first and only transport is a native `<audio>` element consuming one continuous HTTP `audio/mpeg` response. Do not add HLS, WebRTC, WebTransport, MSE, a service worker, native wrapper, PWA, oscillator fallback, or a second transport in this implementation. A second transport requires a new approved design tied to one specific, fixable failure.
- Default configuration is `AUDIO_STREAM_LAB_ENABLED = "0"` and `AUDIO_STREAM_LAB_ALLOW_SHORT_DELAYS = "0"`. A disabled API is indistinguishable from a missing route and performs no Durable Object lookup. The short-delay flag is accepted only on `localhost` or `127.0.0.1`.
- Every API request validates `^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$`, maximum 48 characters, before Durable Object lookup. Every production-connected test creates a fresh `qa-kvk-*` room and a random QA-only password. Local integration runs first.
- Every POST, DELETE, and WebSocket upgrade requires `Origin === new URL(request.url).origin`. The media GET requires a valid private session cookie, rejects cross-site fetch metadata, sets `Cross-Origin-Resource-Policy: same-origin`, and never enables CORS.
- Only enrolled `main`, `weak`, and `weak2` player devices may receive a stream or command. `member`, `commander`, missing, and unknown roles are silent and rejected. This lab has no commander audio path.
- The Durable Object owns delayed execution. Supported production-connected delays are exactly 5, 15, 60, and 180 minutes. A local-only 5-second delay exists for integration tests. Browser code may display times but may not pre-schedule, synthesize, or recover a cue.
- Each selected-player command preserves one immutable `commandId`, `pid`, `role`, `kingdom`, `issuedAtMs`, `fireAtMs`, `audioExpiresAtMs`, `marchSeconds`, and `leadSeconds`. Retry/reconnect never changes those facts. PID and march validation reuse Core `normalizeRoutingKey()` and `parseMarchSeconds()`; the lab may not invent a stricter numeric-only identity or a wider march range.
- A command received or rehydrated at or after `audioExpiresAtMs` is silent. A reconnect may receive only future, not-yet-queued cue frames. It never replays a missed number, GO, queued batch, or expired command.
- A new stream for the same room/device atomically closes the old stream. Command dedupe is `commandId + deviceId`; cancellation can remove only frames not already inside the bounded media buffer. There is no unbounded queue and no catch-up burst.
- Stream metadata uses `audioStreamLabCommand`, `audioStreamLabCancel`, and `audioStreamLabAck`. The lab never sends or accepts core `{t:'deliveryAck', ...}` or Reliable `deliveryShadow*` frames. Diagnostic metadata receipt is not Classic `Received ✓` and not proof of audible delivery.
- Classic comparison facts are read-only evidence. The core command shape remains `{id,type,kingdom,anchorUTC,expiresUTC,payload:{pairs:[{pid,name,role,march,pressUTC}],firstPress,kingdom,leadSeconds},at,delivery:[{pid,expected,received,expired}]}`. The lab may store a sanitized copy without `name`; it never edits or posts that object back to `Room`.
- Private state is bounded to 12 enrolled devices, 6 simultaneous audio streams, 32 pending/recent jobs or commands, and 256 evidence/telemetry events per room. Session lifetime is four hours; command/evidence history expires after 24 hours; stale records are removed by the lab alarm.
- Do not persist or log full user-agent strings, IP addresses, room passwords, raw session tokens, cookie values, free-form player names, media URLs containing identity, or audio content derived from the game. Platform evidence uses coarse enumerations only.
- The committed stream is 24 kHz, mono, MPEG-2 Layer III, CBR 48 kbps with no ID3 or Xing data. Its raw payload is 21.6 MB per device-hour; the gate is 25 MB per device-hour including framing and reconnect overhead.
- Automated tests establish routing, encoding, timing, dedupe, expiry, and client state-machine behavior only. Playwright WebKit is not physical iOS. No background/lock-screen, audio-focus, battery, heat, or promotion claim is allowed without the physical matrix in Task 7.
- If any platform needs user-agent transport branching, persistent audio-focus takeover, or a platform-only alternate pipeline, reject the candidate rather than leaving a permanent transport matrix. Capability checks for optional Media Session controls are allowed and must not affect streamed audio.
- Before modifying any existing function, class, or method, run `gitnexus_impact` upstream and report direct callers, affected processes, and risk. If risk is HIGH or CRITICAL, warn the user before editing.
- Resolve `KVK_WORKTREE` and `GITNEXUS_REPO` with the master plan's executable worktree block before any GitNexus call. Every detect/impact call in this leaf passes the printed literal worktree repository name; never use a root-checkout index whose path differs.
- Before every implementation commit, confirm there are no pre-existing staged files, stage only the task's listed paths, refresh a stale index with `npx gitnexus analyze`, run `gitnexus_detect_changes(scope="staged")`, and confirm Classic Fire, state, countdown, and audio flows are absent from the affected scope. Never unstage or absorb user-owned changes to make the check pass.
- Preserve every unrelated worktree change and every binding/migration added by the core, Reliable, or Backup Push work. Push and Stream research may be reviewed in parallel, but edits to `src/worker.js`, `wrangler.toml`, or `package.json` must be applied sequentially and reconciled, never overwritten.
- The configuration flag blocks new lookups but is not itself proof that already-open HTTP streams ended. A global stop first authenticates and kills every active QA room recorded for the bounded window, verifies each reader reaches EOF, and only then deploys `AUDIO_STREAM_LAB_ENABLED=0` to block new sessions.

---


## File Structure

### Existing files modified

- `kingshoter/src/worker.js` — one fail-closed `/api/lab/audio-stream/` branch and the `AudioStreamLab` export only.
- `kingshoter/wrangler.toml` — default-off flags, independent `AUDIO_STREAM_LAB` binding, and a uniquely tagged SQLite class migration, while preserving every existing entry.
- `kingshoter/package.json` — focused asset, unit, and e2e scripts only.

### New server and asset-build files

- `kingshoter/src/labs/audio-stream/qa-room.mjs` — thin wrapper around Reliable's canonical `isQaRoomName`.
- `kingshoter/src/labs/audio-stream/router.mjs` — global kill switch, QA-room gate, binding check, and DO forwarding.
- `kingshoter/src/labs/audio-stream/policy.mjs` — exact bounds, timing constants, field normalizers, origin/session helpers, and command shape.
- `kingshoter/src/labs/audio-stream/mp3.mjs` — MPEG-2 Layer III frame parser, manifest validation, slicing, and static-asset loader.
- `kingshoter/src/labs/audio-stream/scheduler.mjs` — cue timeline, frame alignment, stream dedupe, bounded buffer, backpressure, and stale suppression.
- `kingshoter/src/labs/audio-stream/audio-stream-lab.mjs` — private sessions, streaming responses, jobs, alarms, lab WebSockets, evidence, cleanup, kill, and status.
- `kingshoter/scripts/build-audio-stream-assets.mjs` — deterministic FFmpeg invocation, raw-frame stripping, exact frame count, and manifest hashes.
- `kingshoter/scripts/run-audio-stream-e2e.mjs` — starts one isolated local Wrangler with both lab flags, waits for readiness, runs the E2E test with the correct base URL, and always terminates the child.

### New hidden client and generated assets

- `kingshoter/public/lab/audio-stream.html` — unlinked, no-index enrollment and explicit Start/Stop UI.
- `kingshoter/public/lab/audio-stream.css` — lab-only styles.
- `kingshoter/public/lab/audio-stream.js` — session bootstrap, native audio lifecycle, Media Session, bounded reconnect, metadata ACK, and diagnostic telemetry.
- `kingshoter/public/lab/audio-stream-assets/manifest.json` — committed format, frame counts, durations, byte lengths, and SHA-256 hashes.
- `kingshoter/public/lab/audio-stream-assets/carrier.mp3` — ten-frame, 240 ms low-amplitude carrier loop.
- `kingshoter/public/lab/audio-stream-assets/tick.mp3` — exactly 41 frames / 984 ms.
- `kingshoter/public/lab/audio-stream-assets/{en,zh}_{1,2,3,4,5,go}.mp3` — normalized spoken lab cues, each exactly 41 frames / 984 ms, derived from the existing player-made site voice files.

### New tests and evidence documentation

- `kingshoter/test/audio-stream-lab-guard.test.cjs` — default-off, QA-only, origin, and Worker-boundary tests.
- `kingshoter/test/audio-stream-lab-assets.test.cjs` — parser, exact encoding, manifest, deterministic build, and static-asset checks.
- `kingshoter/test/audio-stream-lab-scheduler.test.cjs` — timing, personal targeting, dedupe, expiry, reconnect, cancellation, and backpressure tests.
- `kingshoter/test/support/audio-stream-lab-fakes.cjs` — deterministic storage, WebSocket, stream-controller, clock, and asset fakes used only by lab tests.
- `kingshoter/test/audio-stream-lab-storage.test.cjs` — password/session privacy, bounds, stream headers, supersession, and cleanup tests.
- `kingshoter/test/audio-stream-lab-command.test.cjs` — delayed jobs, alarm idempotency, immutable commands, metadata, evidence, and kill tests.
- `kingshoter/test/audio-stream-lab-client.test.cjs` — source/VM tests for explicit playback, reconnect, Media Session, privacy, and ordinary-page invisibility.
- `kingshoter/test/audio-stream-lab.e2e.cjs` — local hidden-page integration with a fresh guarded QA room.
- `kingshoter/docs/qa/kvk-audio-stream-lab.md` — physical matrix, Classic comparison, latency/resource evidence, decision thresholds, kill, and deletion procedure.

### Shared and lab-only interfaces

```js
// Owned by the core plan; consume unchanged.
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

// Owned by Reliable; consume unchanged on the server.
import { isQaRoomName } from '../../delivery.js';

// Owned by the core plan; consume unchanged in the hidden page.
window.getRoomDeviceId(room); // room-local crypto.randomUUID()

// Lab command: Reliable timing facts, isolated type and meaning.
{
  t: 'audioStreamLabCommand', v: 1, lab: true,
  commandId, pid, role: 'main' | 'weak' | 'weak2', kingdom,
  issuedAtMs, fireAtMs, audioExpiresAtMs,
  marchSeconds, leadSeconds
}

// Lab diagnostic metadata ACK; never sent to Room.
{
  t: 'audioStreamLabAck', v: 1, commandId,
  outcome: 'metadata_received' | 'expired',
  receivedAtMs
}

// Core production ACK remains separate and forbidden on lab routes.
{
  t: 'deliveryAck', commandId, pid, deviceId,
  outcome: 'scheduled' | 'expired', targetUTC, scheduledAtMs
}
```

---

### Task 1: Lock the default-off QA and Worker routing boundary

**Files:**
- Create: `kingshoter/src/labs/audio-stream/qa-room.mjs`
- Create: `kingshoter/src/labs/audio-stream/router.mjs`
- Create: `kingshoter/test/audio-stream-lab-guard.test.cjs`
- Modify: `kingshoter/src/worker.js:1-24`

**Interfaces:**
- Consumes: Reliable `isQaRoomName(room)`, `env.AUDIO_STREAM_LAB_ENABLED`, `env.AUDIO_STREAM_LAB`, and `Request`.
- Produces: `requireAudioStreamQaRoom(value): string` and `routeAudioStreamLab(request, env): Promise<Response>`.
- Guarantees: a disabled or invalid request returns before `idFromName`; the Worker has one isolated branch; every existing non-lab route retains its order and behavior.

- [ ] **Step 1: Verify prerequisites and record entry-point impact**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
test -f test/support/qa-kvk.cjs
rg -n "export function isQaRoomName|window\.getRoomDeviceId" src/delivery.js public/app.js
git status --short
```

Expected: both shared interfaces are present. Stop if either is missing. Record all existing dirty paths and do not touch them unless this task explicitly lists them.

Before editing `worker.fetch`, run:

```text
gitnexus_impact({
  target: "fetch",
  file_path: "kingshoter/src/worker.js",
  kind: "Method",
  direction: "upstream",
  includeTests: true,
  repo: "$GITNEXUS_REPO"
})
```

Expected: report the actual direct callers, affected processes, and risk. GitNexus may understate an HTTP entry point with zero code callers, so explicitly record the manual blast radius as every Worker request. If the returned risk is HIGH or CRITICAL, warn the user before proceeding.

- [ ] **Step 2: Write the failing route tests**

Create `test/audio-stream-lab-guard.test.cjs` with these cases:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);

test('stream lab delegates QA syntax to Reliable and rejects every operation room', async () => {
  const { requireAudioStreamQaRoom } = await load('src/labs/audio-stream/qa-room.mjs');
  assert.equal(requireAudioStreamQaRoom('qa-kvk-20260713-a9'), 'qa-kvk-20260713-a9');
  for (const room of ['operation-room', 'weekend-battle', '', 'qa-kvk-', 'QA-KVK-x',
    'qa-kvk-x_', '__proto__', `qa-kvk-${'x'.repeat(42)}`]) {
    assert.throws(() => requireAudioStreamQaRoom(room), /qa_room_required/, room);
  }
});

test('disabled route is a 404 and performs no Durable Object lookup', async () => {
  const { routeAudioStreamLab } = await load('src/labs/audio-stream/router.mjs');
  for (const flag of [undefined, '', '0', 'true']) {
    let lookups = 0;
    const response = await routeAudioStreamLab(
      new Request('https://kingshoter.test/api/lab/audio-stream/status?room=qa-kvk-off'),
      { AUDIO_STREAM_LAB_ENABLED: flag,
        AUDIO_STREAM_LAB: { idFromName() { lookups++; } } }
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(lookups, 0);
  }
});

test('invalid room is rejected before Durable Object lookup', async () => {
  const { routeAudioStreamLab } = await load('src/labs/audio-stream/router.mjs');
  let lookups = 0;
  const env = {
    AUDIO_STREAM_LAB_ENABLED: '1',
    AUDIO_STREAM_LAB: { idFromName() { lookups++; } }
  };
  for (const room of ['operation-room', 'prod', 'qa-kvk-']) {
    const response = await routeAudioStreamLab(
      new Request(`https://kingshoter.test/api/lab/audio-stream/status?room=${room}`), env
    );
    assert.equal(response.status, 403);
  }
  assert.equal(lookups, 0);
});

test('ordinary pages contain no stream-lab hook', () => {
  for (const file of ['public/kvk.html', 'public/kvk.js', 'public/app.js', 'public/app.css']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /AudioStreamLab|audio-stream|stream candidate|reliable audio warning/i, file);
  }
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-guard.test.cjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/labs/audio-stream/qa-room.mjs` or `router.mjs`; the ordinary-page assertion may already pass.

- [ ] **Step 4: Implement the canonical QA wrapper**

Create `src/labs/audio-stream/qa-room.mjs`:

```js
import { isQaRoomName } from '../../delivery.js';

export function requireAudioStreamQaRoom(value) {
  const room = typeof value === 'string' ? value : '';
  if (!isQaRoomName(room)) throw new Error('qa_room_required');
  return room;
}
```

Do not copy Reliable's regular expression here.

- [ ] **Step 5: Implement the fail-closed router**

Create `src/labs/audio-stream/router.mjs`:

```js
import { requireAudioStreamQaRoom } from './qa-room.mjs';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

export async function routeAudioStreamLab(request, env) {
  if (env.AUDIO_STREAM_LAB_ENABLED !== '1') {
    return json({ error: 'not_found' }, 404);
  }

  const url = new URL(request.url);
  let room;
  try { room = requireAudioStreamQaRoom(url.searchParams.get('room')); }
  catch (_) { return json({ error: 'qa_room_required' }, 403); }

  if (!env.AUDIO_STREAM_LAB || typeof env.AUDIO_STREAM_LAB.idFromName !== 'function') {
    return json({ error: 'lab_unavailable' }, 503);
  }

  const id = env.AUDIO_STREAM_LAB.idFromName(`audio-stream:${room}`);
  const headers = new Headers(request.headers);
  headers.delete('x-kvk-audio-stream-room');
  headers.set('x-kvk-audio-stream-room', room);
  return env.AUDIO_STREAM_LAB.get(id).fetch(new Request(request, { headers }));
}
```

The room is revalidated inside the Durable Object in Task 4; the private header is a routing convenience, not an authorization fact.

- [ ] **Step 6: Add only the isolated Worker branch**

In `src/worker.js`, add the import beside existing imports:

```js
import { routeAudioStreamLab } from './labs/audio-stream/router.mjs';
```

Immediately after `const url = new URL(request.url);` and before `/api/ws`, add:

```js
if (url.pathname.startsWith('/api/lab/audio-stream/')) {
  return routeAudioStreamLab(request, env);
}
```

Do not reorder or edit `/api/ws`, gift, lookup, time, codes, scheduled, or static-asset branches. Do not export the not-yet-created Durable Object class in this task.

- [ ] **Step 7: Run GREEN and a static route smoke test**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-guard.test.cjs
npx wrangler deploy --dry-run --outdir /tmp/kingshoter-audio-stream-task1
```

Expected: all guard tests pass; dry-run bundles successfully; disabled/invalid requests perform zero DO lookups; ordinary-page source remains free of lab identifiers.

- [ ] **Step 8: Scope, detect, and commit Task 1**

Run:

```bash
git diff --check
git diff --cached --quiet
git add src/worker.js src/labs/audio-stream/qa-room.mjs src/labs/audio-stream/router.mjs test/audio-stream-lab-guard.test.cjs
git diff --cached --name-only
```

Expected staged paths: exactly the four listed above. If `git diff --cached --quiet` exits nonzero before staging, leave those paths untouched and execute this task in the clean isolated worktree established by the master plan; never unstage, absorb, or overwrite user-owned staged work and do not request another approval.

Run `gitnexus_detect_changes(scope="staged")`. Expected: only the Worker lab branch and new isolated symbols; no `Room`, Classic Fire, countdown, state, or audio process. Then run:

```bash
git diff --cached --check
git commit -m "test: gate audio stream lab routes"
```

Expected: one focused commit.

---

### Task 2: Build deterministic, concatenation-safe MP3 frames

**Files:**
- Create: `kingshoter/src/labs/audio-stream/mp3.mjs`
- Create: `kingshoter/scripts/build-audio-stream-assets.mjs`
- Create: `kingshoter/test/audio-stream-lab-assets.test.cjs`
- Create: `kingshoter/public/lab/audio-stream-assets/manifest.json`
- Create: `kingshoter/public/lab/audio-stream-assets/carrier.mp3`
- Create: `kingshoter/public/lab/audio-stream-assets/tick.mp3`
- Create: `kingshoter/public/lab/audio-stream-assets/{en,zh}_{1,2,3,4,5,go}.mp3`
- Modify: `kingshoter/package.json`

**Interfaces:**
- Produces: `parseMp3Frames(bytes)`, `assertStreamAsset(bytes, expected)`, `sliceMp3Frames(bytes, start, count)`, `loadStreamAssets(assetsBinding)`, and a deterministic manifest.
- Encoding contract: MPEG-2 Layer III, 24,000 Hz, mono, 48,000 bps CBR, 576 samples / 24 ms / 144 bytes per frame, with no ID3, Xing, Info, or VBRI metadata.
- Asset contract: carrier = 10 frames / 240 ms / 1,440 bytes; every tick/voice cue = 41 frames / 984 ms / 5,904 bytes.

- [ ] **Step 1: Write the failing parser and committed-asset tests**

Create `test/audio-stream-lab-assets.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const assetDir = path.join(root, 'public/lab/audio-stream-assets');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('committed assets are raw, fixed-rate MPEG-2 Layer III frames', async () => {
  const { parseMp3Frames } = await load('src/labs/audio-stream/mp3.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(assetDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.format, {
    codec: 'mp3', mpegVersion: 2, layer: 3, sampleRate: 24000,
    channels: 1, bitrateBps: 48000, frameSamples: 576, frameMs: 24, frameBytes: 144
  });
  assert.deepEqual(Object.keys(manifest.assets).sort(), [
    'carrier', 'en_1', 'en_2', 'en_3', 'en_4', 'en_5', 'en_go',
    'tick', 'zh_1', 'zh_2', 'zh_3', 'zh_4', 'zh_5', 'zh_go'
  ]);
  for (const [name, entry] of Object.entries(manifest.assets)) {
    const bytes = fs.readFileSync(path.join(assetDir, entry.file));
    const frames = parseMp3Frames(bytes);
    assert.equal(frames.length, entry.frames, name);
    assert.equal(bytes.length, entry.bytes, name);
    assert.equal(entry.durationMs, entry.frames * 24, name);
    assert.equal(sha256(bytes), entry.sha256, name);
    assert.ok(frames.every((f) => f.byteLength === 144 && f.sampleRate === 24000 &&
      f.bitrateBps === 48000 && f.mpegVersion === 2 && f.layer === 3 && f.channels === 1), name);
  }
  assert.equal(manifest.assets.carrier.frames, 10);
  for (const [name, entry] of Object.entries(manifest.assets)) {
    if (name !== 'carrier') assert.equal(entry.frames, 41, name);
  }
});

test('asset build is deterministic byte for byte', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-stream-assets-'));
  execFileSync(process.execPath, ['scripts/build-audio-stream-assets.mjs', '--output', output], {
    cwd: root, stdio: 'pipe'
  });
  const expected = JSON.parse(fs.readFileSync(path.join(assetDir, 'manifest.json'), 'utf8'));
  const actual = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(actual, expected);
  for (const entry of Object.values(expected.assets)) {
    assert.deepEqual(
      fs.readFileSync(path.join(output, entry.file)),
      fs.readFileSync(path.join(assetDir, entry.file)),
      entry.file
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-assets.test.cjs
```

Expected: FAIL because `mp3.mjs`, the builder, manifest, and generated assets do not exist.

- [ ] **Step 3: Implement strict MP3 frame parsing**

Create `src/labs/audio-stream/mp3.mjs`. Export the four functions in this task's interface and enforce this exact header logic:

```js
const EXPECTED = Object.freeze({
  mpegVersion: 2, layer: 3, sampleRate: 24000, channels: 1,
  bitrateBps: 48000, frameSamples: 576, frameMs: 24, frameBytes: 144
});

export function parseMp3Frames(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      throw new Error(`invalid_mp3_sync:${offset}`);
    }
    const versionBits = (bytes[offset + 1] >> 3) & 3;
    const layerBits = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 15;
    const sampleIndex = (bytes[offset + 2] >> 2) & 3;
    const padding = (bytes[offset + 2] >> 1) & 1;
    const channelMode = (bytes[offset + 3] >> 6) & 3;
    if (versionBits !== 2 || layerBits !== 1 || bitrateIndex !== 6 || sampleIndex !== 1 ||
        padding !== 0 || channelMode !== 3) throw new Error(`unsupported_mp3_frame:${offset}`);
    const byteLength = 144;
    if (offset + byteLength > bytes.length) throw new Error(`truncated_mp3_frame:${offset}`);
    frames.push({ offset, byteLength, ...EXPECTED });
    offset += byteLength;
  }
  if (!frames.length) throw new Error('empty_mp3');
  return frames;
}
```

`assertStreamAsset` must call `parseMp3Frames`, compare every expected manifest field, and reject leading/trailing bytes. `sliceMp3Frames` must return a copied `Uint8Array` on exact frame boundaries. `loadStreamAssets(assetsBinding)` must fetch each manifest entry once, validate hashes with `crypto.subtle.digest('SHA-256', bytes)`, freeze the returned manifest, and cache only inside the calling Durable Object instance; do not use a mutable module-global cache.

- [ ] **Step 4: Implement the deterministic builder**

Create `scripts/build-audio-stream-assets.mjs` using `spawnSync`, never a shell string. It must:

1. Resolve FFmpeg from `process.env.FFMPEG || 'ffmpeg'` and fail with `ffmpeg_required` if unavailable.
2. Write intermediates to `fs.mkdtempSync(path.join(os.tmpdir(), 'kvk-audio-stream-'))`.
3. Generate carrier with `sine=frequency=40:sample_rate=24000:duration=0.24,volume=0.0005` and tick with a 72 ms 880 Hz tone followed by padding.
4. Re-encode existing `public/sfx/{en,zh}_{1,2,3,4,5,go}.mp3` with `silenceremove=start_periods=1:start_duration=0.02:start_threshold=-42dB:stop_periods=-1:stop_duration=0.08:stop_threshold=-42dB,apad=pad_dur=0.984,atrim=duration=0.984`, then verify the resulting 984 ms speech window.
5. Pass these common output arguments in this exact order:

```js
const encodeArgs = [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  /* input arguments inserted here */
  '-map_metadata', '-1', '-vn', '-ac', '1', '-ar', '24000',
  '-codec:a', 'libmp3lame', '-b:a', '48k', '-minrate', '48k', '-maxrate', '48k',
  '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', outputFile
];
```

After FFmpeg exits, parse from the first valid fixed header, discard encoder metadata/delay frames as needed, retain exactly 10 carrier frames or 41 cue frames, and reject any remaining nonconforming frame. Write each file and a lexically sorted manifest with SHA-256 hashes. Build in a temporary directory and rename only complete outputs, so a failed build cannot leave a partial committed set.

For normalized voice files, inspect decoded PCM and fail if the RMS speech window is silent or if non-silent speech reaches the final 72 ms; this prevents truncating a word merely to satisfy the frame count. Adjust only the `silenceremove` thresholds in the builder if an existing source fails; do not lengthen a cue or add a second format.

- [ ] **Step 5: Add the focused package script and generate assets**

Add to `package.json` without changing dependency versions:

```json
"build:audio-stream-assets": "node scripts/build-audio-stream-assets.mjs",
"test:audio-stream-lab": "node --test test/audio-stream-lab-*.test.cjs"
```

Preserve the existing `test`, `deploy`, and `dev` scripts and any scripts added by another plan.

Run:

```bash
cd $KVK_WORKTREE/kingshoter
npm run build:audio-stream-assets
node --test test/audio-stream-lab-assets.test.cjs
```

Expected: the builder reports 14 assets; the test passes; carrier is 1,440 bytes; each other file is 5,904 bytes; every manifest hash matches.

- [ ] **Step 6: Verify audio content manually without changing bytes**

Run:

```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,bit_rate -of json public/lab/audio-stream-assets/en_5.mp3
ffplay -nodisp -autoexit public/lab/audio-stream-assets/en_5.mp3
ffplay -nodisp -autoexit public/lab/audio-stream-assets/zh_go.mp3
```

Expected: `mp3`, `24000`, mono, approximately `48000`; both cues are intelligible, begin promptly, and end without clipping. Carrier is intentionally near-silent and is not used as evidence of background survival by itself.

- [ ] **Step 7: Scope, detect, and commit Task 2**

Run:

```bash
git diff --check
git diff --cached --quiet
git add package.json scripts/build-audio-stream-assets.mjs src/labs/audio-stream/mp3.mjs test/audio-stream-lab-assets.test.cjs public/lab/audio-stream-assets
git diff --cached --name-only
```

Expected: only Task 2 paths. Run `gitnexus_detect_changes(scope="staged")`; expected scope is isolated asset generation/parsing with no application execution flow. Then:

```bash
git diff --cached --check
git commit -m "feat: build fixed-frame stream lab audio"
```

Expected: one focused commit including generated assets and their reproducible manifest.

---

### Task 3: Implement the immutable cue timeline and bounded stream scheduler

**Files:**
- Create: `kingshoter/src/labs/audio-stream/policy.mjs`
- Create: `kingshoter/src/labs/audio-stream/scheduler.mjs`
- Create: `kingshoter/test/audio-stream-lab-scheduler.test.cjs`

**Interfaces:**
- Produces: `normalizeLabCommand(raw, nowMs)`, `makeCueTimeline(command, language)`, `frameAtOrAfter(atMs)`, and `StreamScheduler`.
- `StreamScheduler` exposes `open({deviceId, controller, nowMs})`, `install(command, deviceIds)`, `cancel(commandId)`, `pump(nowMs)`, `closeDevice(deviceId, reason)`, `closeAll(reason)`, and `snapshot(nowMs)`.
- The scheduler owns byte selection only. It has no timer, alarm, storage, HTTP, WebSocket, UI, AudioContext, or Classic dependency.

- [ ] **Step 1: Write failing timing, targeting, and safety tests**

Create `test/audio-stream-lab-scheduler.test.cjs` with a fake controller whose `enqueue(bytes)` records copied buffers, `close()` records closure, and writable `desiredSize` simulates backpressure. Cover these exact cases:

```js
test('timeline is ticks 10..6, spoken 5..1, then GO on immutable absolute times', async () => {
  const { makeCueTimeline } = await load('src/labs/audio-stream/scheduler.mjs');
  const command = {
    t: 'audioStreamLabCommand', v: 1, lab: true, commandId: 'cmd-a',
    pid: '700001', role: 'main', kingdom: 1, issuedAtMs: 90_000,
    fireAtMs: 100_000, audioExpiresAtMs: 100_150, marchSeconds: 31, leadSeconds: 10
  };
  assert.deepEqual(makeCueTimeline(command, 'en').map(({ atMs, asset }) => [atMs, asset]), [
    [90_000, 'tick'], [91_000, 'tick'], [92_000, 'tick'], [93_000, 'tick'], [94_000, 'tick'],
    [95_000, 'en_5'], [96_000, 'en_4'], [97_000, 'en_3'], [98_000, 'en_2'],
    [99_000, 'en_1'], [100_000, 'en_go']
  ]);
});

test('same command targets only enrolled selected devices and dedupes command plus device', async () => {
  const { StreamScheduler } = await load('src/labs/audio-stream/scheduler.mjs');
  const h = makeSchedulerHarness();
  h.open('device-main', 89_500);
  h.open('device-weak', 89_500);
  h.open('device-member', 89_500);
  assert.equal(h.scheduler.install(h.command, ['device-main', 'device-weak']), 2);
  assert.equal(h.scheduler.install(h.command, ['device-main', 'device-weak']), 0);
  h.scheduler.pump(89_520);
  assert.ok(h.bytes('device-main') > 0);
  assert.ok(h.bytes('device-weak') > 0);
  assert.equal(h.cueBytes('device-member'), 0);
});

test('reconnect supersedes the old stream and never replays a past cue', async () => {
  const h = makeSchedulerHarness();
  const first = h.open('device-main', 94_000);
  h.scheduler.install(h.command, ['device-main']);
  h.scheduler.pump(95_000);
  const second = h.open('device-main', 97_200);
  assert.equal(first.closed, 'superseded');
  h.scheduler.pump(97_200);
  assert.equal(h.assets(second).includes('en_5'), false);
  assert.equal(h.assets(second).includes('en_4'), false);
  assert.equal(h.assets(second).includes('en_3'), false);
  assert.ok(h.assets(second).some((name) => ['en_2', 'en_1', 'en_go', 'carrier'].includes(name)));
});

test('expired, cancelled, overlapping, and blocked work is silent and bounded', async () => {
  const h = makeSchedulerHarness();
  const stream = h.open('device-main', 89_000);
  h.scheduler.install(h.command, ['device-main']);
  h.scheduler.cancel('cmd-a');
  h.scheduler.pump(95_000);
  assert.equal(h.assets(stream).includes('en_5'), false);
  assert.equal(h.scheduler.install({ ...h.command, commandId: 'expired', audioExpiresAtMs: 90_000 }, ['device-main']), 0);
  stream.desiredSize = 0;
  h.scheduler.pump(101_000);
  h.scheduler.pump(102_001);
  assert.equal(stream.closed, 'backpressure');
  assert.ok(h.scheduler.snapshot(102_001).queuedBytes <= 12_000);
});
```

The helper must also assert:

- cue starts round to the nearest 24 ms frame with no more than 12 ms alignment error;
- adjacent 41-frame cues never overlap;
- `audioExpiresAtMs <= fireAtMs` is rejected;
- role other than `main`/`weak`/`weak2`, Core-invalid routing keys (including `__proto__`, `constructor`, whitespace, and punctuation), inherited player keys, noninteger times, lead other than 10, and bounds violations are rejected;
- opaque Core-valid PIDs such as `n-qa-alpha` are accepted exactly, while march values below 5 or above 180 are rejected;
- cancellation never mutates the original command object;
- no connection receives more than `TARGET_BUFFER_MS + PUMP_MS` of queued frames;
- byte count is exact for every enqueue.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-scheduler.test.cjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `policy.mjs` or `scheduler.mjs`.

- [ ] **Step 3: Implement exact policy and command normalization**

Create `src/labs/audio-stream/policy.mjs` with the Core validators and these frozen constants:

```js
import { normalizeRoutingKey, parseMarchSeconds } from '../../room-player.js';

export const STREAM_POLICY = Object.freeze({
  VERSION: 1,
  BITRATE_BPS: 48_000,
  FRAME_BYTES: 144,
  FRAME_MS: 24,
  CARRIER_FRAMES: 10,
  CUE_FRAMES: 41,
  PUMP_MS: 120,
  TARGET_BUFFER_MS: 480,
  MAX_BUFFER_BYTES: 12_000,
  BACKPRESSURE_CLOSE_MS: 1_000,
  AUDIO_GRACE_MS: 150,
  LEAD_SECONDS: 10,
  MAX_DEVICES: 12,
  MAX_STREAMS: 6,
  MAX_OPERATIONS: 32,
  MAX_EVENTS: 256,
  SESSION_TTL_MS: 4 * 60 * 60 * 1000,
  HISTORY_TTL_MS: 24 * 60 * 60 * 1000,
  PROD_DELAYS_MS: Object.freeze([5, 15, 60, 180].map((m) => m * 60_000)),
  LOCAL_DELAY_MS: 5_000
});
```

`normalizeLabCommand(raw, nowMs)` must return a new deeply frozen object only when:

- `t === 'audioStreamLabCommand'`, `v === 1`, and `lab === true`;
- `commandId` is 1..64 safe `[A-Za-z0-9:_-]` characters and `pid === normalizeRoutingKey(raw.pid)`; inherited/reserved/malformed keys are rejected;
- role is `main`, `weak`, or `weak2`, kingdom is integer 1 or 2, `parseMarchSeconds(raw.marchSeconds)` is non-null (therefore exactly Core's 5..180 range), and lead is exactly 10;
- all times are safe integers, `issuedAtMs <= fireAtMs`, and `audioExpiresAtMs === fireAtMs + 150`;
- normalization does not make an already-expired command live. Return `null` when `nowMs >= audioExpiresAtMs`.

Also export `requireSameOrigin(request)`, `json(body,status)`, `boundedText`, and exact enum validators used by Tasks 4–6. `json` always emits `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; it never emits CORS.

- [ ] **Step 4: Implement frame-aligned cue selection**

Create `src/labs/audio-stream/scheduler.mjs`. The alignment functions must be explicit:

```js
import { STREAM_POLICY, normalizeLabCommand } from './policy.mjs';
import { sliceMp3Frames } from './mp3.mjs';

export const frameAtOrAfter = (atMs) => Math.ceil(atMs / STREAM_POLICY.FRAME_MS) * STREAM_POLICY.FRAME_MS;
export const nearestFrame = (atMs) => Math.round(atMs / STREAM_POLICY.FRAME_MS) * STREAM_POLICY.FRAME_MS;

export function makeCueTimeline(command, language) {
  const lang = language === 'zh' ? 'zh' : 'en';
  const result = [];
  for (let n = 10; n >= 6; n--) result.push({ atMs: command.fireAtMs - n * 1000, asset: 'tick' });
  for (let n = 5; n >= 1; n--) result.push({ atMs: command.fireAtMs - n * 1000, asset: `${lang}_${n}` });
  result.push({ atMs: command.fireAtMs, asset: `${lang}_go` });
  return result.map((cue) => ({ ...cue, frameAtMs: nearestFrame(cue.atMs) }));
}
```

Implement `StreamScheduler` with these rules:

1. `open` starts `nextFrameAtMs` at `frameAtOrAfter(nowMs + 480)`, registers at most six streams, and closes an old same-device controller with reason `superseded` before replacing it.
2. `install` stores a frozen normalized command separately for each listed active/enrolled device, keyed by `${commandId}\u0000${deviceId}`. A second install returns zero and emits nothing.
3. `pump` walks each stream only until `frameAtOrAfter(nowMs + 480)`. It chooses the next future cue frame; carrier chunks stop before that frame. A cue is enqueued once and advances the logical play head by exactly 41 frames.
4. A cue with `frameAtMs < connection.nextFrameAtMs`, `atMs < nowMs`, a cancelled command, or `nowMs >= audioExpiresAtMs` is deleted without enqueue. This is the no-replay rule.
5. `desiredSize <= 0` queues nothing. If it stays nonpositive for more than 1,000 ms, close the stream; never buffer the missed interval for later.
6. Count copied bytes per connection. Refuse an enqueue that would place more than 12,000 unread bytes behind the controller and close with `buffer_limit`.
7. `closeDevice`/`closeAll` close controllers idempotently and delete ephemeral cue state. Controller exceptions affect only that stream.

The carrier file is a ten-frame source loop. Slice one to ten frames as necessary so carrier never crosses an upcoming cue boundary. The scheduler must not use `setTimeout`, `Date.now`, `AudioContext`, or a WebSocket.

- [ ] **Step 5: Run GREEN and mutation-focused checks**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-assets.test.cjs test/audio-stream-lab-scheduler.test.cjs
```

Expected: all tests pass; exact byte totals and frame alignment are stable; no expired/past cue is ever enqueued.

- [ ] **Step 6: Scope, detect, and commit Task 3**

Run:

```bash
git diff --check
git diff --cached --quiet
git add src/labs/audio-stream/policy.mjs src/labs/audio-stream/scheduler.mjs test/audio-stream-lab-scheduler.test.cjs
git diff --cached --name-only
```

Run `gitnexus_detect_changes(scope="staged")`. Expected: new isolated timing/scheduler symbols only, with no `Room` or browser audio process. Then:

```bash
git diff --cached --check
git commit -m "feat: schedule bounded server stream cues"
```

---

### Task 4: Add private sessions and the continuous media response

**Files:**
- Create: `kingshoter/src/labs/audio-stream/audio-stream-lab.mjs`
- Create: `kingshoter/test/support/audio-stream-lab-fakes.cjs`
- Create: `kingshoter/test/audio-stream-lab-storage.test.cjs`
- Modify: `kingshoter/src/worker.js:1-12`
- Modify: `kingshoter/wrangler.toml`

**Interfaces:**
- Produces: `AudioStreamLab.fetch(request)`, session bootstrap, authenticated status, continuous `audio/mpeg`, stream supersession, cleanup, and one shared in-memory pump timer.
- Storage key: `audio-stream-lab:v1`, containing only `{v,room,password,sessions,devices,jobs,commands,events,killedAtMs,updatedAtMs}` with bounded arrays/maps serialized as arrays.
- Cookie: `kvk_audio_stream_session`, HttpOnly, Secure on HTTPS, SameSite=Strict, Path=`/api/lab/audio-stream/`, Max-Age at most four hours.

- [ ] **Step 1: Write failing storage, privacy, and stream-response tests**

Create the fake support and test files. The fakes must implement only Durable Object APIs actually used: transactional `get/put/delete`, `getAlarm/setAlarm/deleteAlarm`, `blockConcurrencyWhile`, `waitUntil`, `acceptWebSocket`, `getWebSockets`, and deterministic `env.ASSETS.fetch`.

Required tests:

```js
test('first valid QA session claims a room and stores only derived secrets', async () => {
  const h = await createAudioStreamLabHarness({ room: 'qa-kvk-session' });
  const response = await h.post('/session', {
    password: 'random-qa-only-password-9fQ2', deviceId: 'device-a', pid: '700001',
    role: 'main', marchSeconds: 31, language: 'en',
    platform: { os: 'ios', browser: 'safari', formFactor: 'phone' }
  }, { origin: true });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /^kvk_audio_stream_session=/);
  const raw = JSON.stringify(await h.stored());
  assert.doesNotMatch(raw, /random-qa-only-password|kvk_audio_stream_session=/);
  assert.doesNotMatch(raw, /Mozilla|127\.0\.0\.1/);
});

test('stream is fixed-rate same-origin media and a second stream supersedes the first', async () => {
  const h = await enrolledHarness();
  const first = await h.get('/stream', { cookie: h.cookie });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'audio/mpeg');
  assert.equal(first.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(first.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.headers.has('content-length'), false);
  const firstReader = first.body.getReader();
  assert.ok((await firstReader.read()).value.byteLength > 0);
  const second = await h.get('/stream', { cookie: h.cookie });
  assert.equal(second.status, 200);
  assert.equal((await firstReader.read()).done, true);
});

```

Add complete harness tests—not empty test bodies—for member/commander rejection, missing/wrong Origin, mismatched routing room, thirteenth device, seventh stream, invalid pid/device/language/platform, and absent cookie. Seed storage through the fake transaction API with 13 sessions, 40 operations, and 300 events; invoke cleanup and assert the exact limits 12/32/256 and both TTL cutoffs. Also assert every JSON response is no-store/nosniff, no status route is public, cross-site `Sec-Fetch-Site` is rejected for media, and disconnect/cancel removes the controller without replay state.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-storage.test.cjs
```

Expected: FAIL because the class and fakes do not exist.

- [ ] **Step 3: Implement private room claim and session authentication**

In `audio-stream-lab.mjs`, re-run `requireAudioStreamQaRoom(request.headers.get('x-kvk-audio-stream-room'))` on every request and verify it equals the `room` query. Implement:

- password input 20..128 characters; generate a 16-byte salt and derive 32 bytes with WebCrypto PBKDF2/SHA-256 at 100,000 iterations;
- constant-time byte comparison for later enrollment attempts;
- 32 random bytes for each session token; persist only SHA-256(token), never the token;
- device IDs 1..64 `[A-Za-z0-9:_-]`; PIDs pass the imported Core `normalizeRoutingKey()` own-key policy; roles are exactly main/weak/weak2; march passes imported Core `parseMarchSeconds()` (5..180); language is en/zh;
- coarse platform values only: OS `ios|android|macos|windows`, browser `safari|chrome|edge`, form factor `phone|tablet|desktop`;
- first valid password claims an empty QA DO; later sessions must match it; a killed room cannot be reclaimed;
- session rotation replaces the same device's old token and closes its old stream;
- every session expires at `min(now+4h, room-history cutoff)`.

`POST /session` is the only unauthenticated lab operation after routing, but still requires same Origin and the room password. Every other operation calls `requireSession(request,state)`.

- [ ] **Step 4: Implement the native stream response and one shared pump**

On `GET /stream`:

1. Reject `Sec-Fetch-Site: cross-site`, require the private cookie, recheck role, room, session expiry, killed state, and six-stream bound.
2. Await `loadStreamAssets(env.ASSETS)` once per class instance.
3. Create one `ReadableStream` with a byte-length high-water mark no greater than 12,000 bytes. In `start(controller)`, call `scheduler.open`; in `cancel()`, call `scheduler.closeDevice` only if this stream is still current.
4. Call `ensurePump()`. The class owns one `setTimeout` chain at 120 ms for all active streams, never one interval per device. Each tick calls `scheduler.pump(Date.now())`; stop scheduling when no stream remains.
5. Return headers exactly:

```js
{
  'Content-Type': 'audio/mpeg',
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Disposition': 'inline'
}
```

Do not set `Content-Length`, `Accept-Ranges`, CORS, a download filename, room, pid, or device header. If the isolate is evicted, the HTTP stream may end; the client reconnect policy in Task 6 handles it without server replay.

- [ ] **Step 5: Bind and export the isolated Durable Object default-off**

Before changing the existing Worker export list, run `gitnexus_impact` for the exported Worker module symbol GitNexus reports and document its scope. Warn before proceeding if HIGH/CRITICAL.

Add to `src/worker.js`:

```js
export { AudioStreamLab } from './labs/audio-stream/audio-stream-lab.mjs';
```

In `wrangler.toml`, preserve every existing binding, migration, variable, route, and trigger. Add or merge the vars table:

```toml
[vars]
AUDIO_STREAM_LAB_ENABLED = "0"
AUDIO_STREAM_LAB_ALLOW_SHORT_DELAYS = "0"
```

If `[vars]` already exists, add keys inside it; never create a second table. Add:

```toml
[[durable_objects.bindings]]
name = "AUDIO_STREAM_LAB"
class_name = "AudioStreamLab"

[[migrations]]
tag = "audiostreamlab-add-20260713"
new_sqlite_classes = ["AudioStreamLab"]
```

Abort if that tag already exists or if another pending plan uses it. Do not alter `ROOM`, `DELIVERY_LAB`, their classes, or their migration history.

- [ ] **Step 6: Run GREEN, bundling, and disabled-first smoke checks**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-guard.test.cjs test/audio-stream-lab-assets.test.cjs test/audio-stream-lab-scheduler.test.cjs test/audio-stream-lab-storage.test.cjs
npx wrangler deploy --dry-run --outdir /tmp/kingshoter-audio-stream-task4
rg -n "AUDIO_STREAM_LAB_ENABLED = \"0\"|audiostreamlab-add-20260713|class_name = \"AudioStreamLab\"" wrangler.toml
```

Expected: all tests pass, bundle succeeds, and config is disabled by default.

- [ ] **Step 7: Scope, detect, and commit Task 4**

Stage only the five task paths. Run `gitnexus_detect_changes(scope="staged")`. Expected new session/media flow plus the already-reviewed Worker branch/export; no `Room`, Classic audio, or Reliable flow. Then commit:

```bash
git commit -m "feat: serve private QA battle audio streams"
```

---

### Task 5: Add server-owned delayed commands, metadata, evidence, and kill

**Files:**
- Modify: `kingshoter/src/labs/audio-stream/audio-stream-lab.mjs`
- Modify: `kingshoter/src/labs/audio-stream/policy.mjs`
- Modify: `kingshoter/test/support/audio-stream-lab-fakes.cjs`
- Create: `kingshoter/test/audio-stream-lab-command.test.cjs`

**Interfaces:**
- Produces authenticated `POST /arm`, `POST /cancel`, `GET /socket`, `POST /evidence`, `POST /telemetry`, `POST /kill`, `GET /status`, and `AudioStreamLab.alarm()`.
- A job stores only target pids and immutable enrolled facts; its alarm creates per-target command envelopes and injects them into active/reconnected streams.
- Metadata is diagnostic. Audible truth comes only from a physical observer record.

- [ ] **Step 1: Write failing delayed-job and isolation tests**

Before modifying the now-existing `AudioStreamLab` class or `normalizeLabCommand`, run upstream `gitnexus_impact` on both symbols, report direct callers/affected flows/risk, and warn the user before proceeding on HIGH or CRITICAL. The expected scope is the isolated lab route, but the graph result—not this expectation—is authoritative.

Cover these exact behaviors in `test/audio-stream-lab-command.test.cjs`:

- arm accepts exactly 5/15/60/180 minutes; 5 seconds is rejected on a public hostname even when the flag is set and accepted only on `localhost`/`127.0.0.1` with the flag `1`;
- target PIDs must resolve to the exact enrolled role set for the requested Double (`weak+main`) or Triple (`weak+weak2+main`) mode; commander/member cannot be invented in the arm body;
- duplicate/overlapping jobs for a device inside the same 11-second cue window are rejected with 409;
- the earliest pending job owns the one DO alarm; arming later work does not move it later;
- an alarm firing twice creates no duplicate command or cue;
- at due time, compute `roleOffsetMs = role === 'main' ? 1000 : 0` for both `weak` and `weak2`, `rawPressMs = roleOffsetMs - marchSeconds*1000`, `firstRawMs = min(rawPressMs)`, and each target's `fireAtMs = dueAtMs + 10_000 + rawPressMs - firstRawMs`; therefore both Sacrifice landings are equal and Main lands exactly one second later, matching Core/Triple semantics while the earliest personal press remains exactly ten seconds after due;
- every target device sharing a pid receives the same commandId/fire time; different pids may have different personal fire times;
- `audioExpiresAtMs === fireAtMs + 150`, `issuedAtMs === dueAtMs`, kingdom is the validated arm value, and every other field remains byte-equivalent on reconnect;
- audio bytes are queued even when the metadata WebSocket is absent, proving browser JavaScript is not the cue authority;
- a reconnect before GO receives future cues only; a reconnect after expiry receives no command bytes or metadata;
- cancel removes future cue state, emits one `audioStreamLabCancel`, and never reschedules Classic or sends `deliveryShadowCancel`;
- incoming `deliveryAck`, every `deliveryShadow*`, wrong command/device ACK, and expired ACK are rejected/ignored without changing state;
- 32-operation and 256-event bounds are enforced; telemetry is throttled to one event per device per five seconds;
- `/kill` cancels the alarm, closes all audio/WebSockets, clears sessions/jobs/commands, records `killedAtMs`, and makes every later route return 410; the successful kill response itself contains the final bounded receipt.

Use a byte-level assertion that two devices for one pid receive the same cue asset sequence and command facts, while stream connection epochs and byte counters remain device-specific.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-command.test.cjs
```

Expected: FAIL because job, alarm, socket, evidence, and kill handlers do not exist.

- [ ] **Step 3: Implement validated job planning and the single alarm**

`POST /arm` body is exactly:

```js
{
  delayMs: 300000 | 900000 | 3600000 | 10800000 | 5000,
  kingdom: 1 | 2,
  rallyMode: 'double' | 'triple',
  targetPids: ['700001', '700002'] // exactly 2 for double; exactly 3 for triple
}
```

Require unique enrolled PIDs whose roles exactly cover `weak+main` for Double or `weak+weak2+main` for Triple; reject a missing/duplicate role or a count that does not match `rallyMode`. Ignore/reject any client-supplied command ID, issued/fire/expiry time, role, march, language, or device target. Snapshot those fields from current enrollment when arming. Generate `jobId` and, at due time, one command ID with `crypto.randomUUID()` bounded to 64 characters.

Add deterministic command tests for both modes. The Triple case enrolls three selected captain devices, proves both Sacrifices have equal landing time and Main is one second later, and proves enrolled commander/member devices receive no metadata or stream cue.

Persist the job before calling `state.storage.setAlarm(earliestDueAtMs)`. `alarm()` runs inside `blockConcurrencyWhile`, reloads state, sorts due jobs by `[dueAtMs,jobId]`, claims each once, creates immutable target commands, persists before broadcasting/installing, prunes, then sets the next earliest alarm or deletes it. If installation/broadcast throws after persistence, reconnect rehydrates the same facts; it does not mint another ID.

- [ ] **Step 4: Implement hibernatable diagnostic metadata**

`GET /socket` requires an exact same-origin `Origin`, the private session cookie, and a WebSocket upgrade. Accept it with an attachment containing only `{room,deviceId,sessionHash,expiresAtMs}`. On connect, send future unexpired `audioStreamLabCommand` envelopes directed to that device; never send audio bytes through the socket.

Accept only:

```js
{
  t: 'audioStreamLabAck', v: 1, commandId,
  outcome: 'metadata_received' | 'expired', receivedAtMs
}
```

Derive device ID from the attachment, not the message. Store at most one exact ACK per `commandId+deviceId`; contradictory duplicates become bounded diagnostic errors. WebSocket absence/closure never changes `StreamScheduler` or job state. Implement `webSocketClose`/`webSocketError` as metadata cleanup only.

- [ ] **Step 5: Implement bounded telemetry and human evidence**

`POST /telemetry` accepts only event enum `playing|waiting|stalled|pause|ended|error|visibility|reconnect`, integer client time, visibility `visible|hidden`, buffered-ahead 0..30,000 ms, and optional error enum `not_allowed|network|decode|aborted|unknown`. Round media current time to 100 ms; reject full UA or arbitrary strings.

`POST /evidence` accepts one of:

```js
{
  kind: 'audibleObservation', commandId,
  state: 'foreground' | 'background' | 'kingshot_foreground' | 'lockscreen',
  heard: true | false, heardAtMs: integer | null,
  duplicateWithinStream: boolean, duplicateWithClassic: boolean,
  gameAudio: 'unchanged' | 'ducked' | 'stopped' | 'unknown',
  staleAfterExpiry: boolean,
  noteCode: 'none' | 'late' | 'cut_off' | 'wrong_player' | 'recovered_after_unlock'
}
```

or a sanitized `classicBaseline` whose command uses the core shape from Global Constraints but drops every `name` field and rejects unknown keys. Store Classic baseline and Stream results beside each other, never merge their delivery counts. `GET /status` is authenticated and returns private bounded facts; there is no public summary and no change to `Room.snapshot()`.

- [ ] **Step 6: Implement room kill and expiry cleanup**

`POST /kill` requires same Origin, a current session, and password re-entry. After password verification, atomically set `killedAtMs`, clear private tokens/jobs/commands, cancel the DO alarm, emit final metadata `audioStreamLabKilled`, and close all audio controllers/WebSockets. The response is sent only after storage succeeds. Cleanup also runs on every request and alarm and removes expired sessions/history.

- [ ] **Step 7: Run GREEN and regression tests**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-guard.test.cjs test/audio-stream-lab-assets.test.cjs test/audio-stream-lab-scheduler.test.cjs test/audio-stream-lab-storage.test.cjs test/audio-stream-lab-command.test.cjs
```

Expected: all tests pass; delayed work is server-owned; alarm duplication, reconnect, cancellation, and expiry produce no stale/duplicate cue; forbidden production frames never enter lab state.

- [ ] **Step 8: Scope, detect, and commit Task 5**

Stage only the four task paths and run `gitnexus_detect_changes(scope="staged")`. Expected: isolated AudioStreamLab alarm/metadata/evidence flows only. No `Room` alarm, Classic command, or Reliable retry flow may appear. Commit:

```bash
git commit -m "feat: drive stream lab commands from server alarms"
```

---

### Task 6: Build the explicit native-audio client and local integration

**Files:**
- Create: `kingshoter/public/lab/audio-stream.html`
- Create: `kingshoter/public/lab/audio-stream.css`
- Create: `kingshoter/public/lab/audio-stream.js`
- Create: `kingshoter/test/audio-stream-lab-client.test.cjs`
- Create: `kingshoter/test/audio-stream-lab.e2e.cjs`
- Create: `kingshoter/scripts/run-audio-stream-e2e.mjs`
- Modify: `kingshoter/package.json`

**Interfaces:**
- Consumes: `window.getRoomDeviceId(room)`, private session cookie, native `HTMLAudioElement`, optional `navigator.mediaSession`, and lab-only metadata WebSocket.
- Produces: explicit Join, Start Stream, Stop Stream, Arm Test, Cancel, observation, and room-kill controls on the hidden page only.
- Audio authority: the page starts/stops/reconnects the native element; it never selects a cue asset, schedules a timeout for a cue, decodes MP3, speaks, beeps, or uses Web Audio.

- [ ] **Step 1: Write failing source and state-machine tests**

Create `test/audio-stream-lab-client.test.cjs`. Execute the client in a VM with fake DOM, `Audio`, `WebSocket`, `fetch`, clock, and Media Session objects. Assert:

- a non-QA or absent room disables every control and makes zero API, WebSocket, or audio request;
- page evaluation and successful Join make no `audio.play()` call;
- only a direct `#startStream` click creates an audio element, sets `/api/lab/audio-stream/stream?room=...`, and calls `play()` synchronously in the click handler;
- `NotAllowedError` stops automatic retries, leaves Classic untouched, and displays a neutral “Tap Start Stream” state;
- network/decode/ended failures retry only while `userStarted && !userPaused`, at 1/2/4/8 seconds, with no more than four attempts in a rolling minute;
- each retry pauses the old element, removes `src`, calls `load()`, drops handlers, and creates a new element/connection epoch;
- explicit Stop and Media Session pause set `userPaused`, cancel pending retry, and prevent visibility/network events from restarting audio;
- Media Session play resumes only after prior explicit start, and metadata contains no room, pid, device ID, kingdom, or command ID;
- metadata socket loss does not stop/restart audio; an `audioStreamLabCommand` ACK contains only the lab shape and never `deliveryAck`/`deliveryShadowAck`;
- a metadata command at/after expiry is ACKed `expired` and causes no audio action;
- telemetry is enum-only, rounded, and at most once per five seconds per event state;
- `public/kvk.html`, `kvk.js`, `app.js`, and `app.css` contain no lab hook, and the lab HTML has no link from any ordinary page.

Also source-scan `audio-stream.js` and fail on `AudioContext`, `webkitAudioContext`, `SpeechSynthesis`, `setTimeout(...cue...)`, `/api/ws`, service-worker registration, MSE, HLS, WebRTC, WebTransport, user-agent transport selection, or any `deliveryAck` send.

- [ ] **Step 2: Run the client test and verify RED**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-client.test.cjs
```

Expected: FAIL because the hidden client files do not exist.

- [ ] **Step 3: Create an unlinked, inert lab page**

`public/lab/audio-stream.html` must include:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>KvK Battle Audio Stream QA Lab</title>
  <link rel="stylesheet" href="/lab/audio-stream.css">
</head>
<body>
  <main id="lab" aria-labelledby="title">
    <h1 id="title">Battle Audio Stream QA Lab</h1>
    <p>This hidden page plays synthetic QA countdowns. Classic remains the production path.</p>
    <form id="joinForm">
      <label>Room <input id="room" name="room" readonly></label>
      <label>QA password <input id="password" name="password" type="password" minlength="20" maxlength="128" required></label>
      <label>Player ID or test nickname <input id="pid" name="pid" autocapitalize="off" pattern="[A-Za-z0-9_-]{1,24}" required></label>
      <label>Role <select id="role" name="role"><option value="main">main</option><option value="weak">weak / Sacrifice 1</option><option value="weak2">weak2 / Sacrifice 2</option></select></label>
      <label>March seconds <input id="marchSeconds" name="marchSeconds" type="number" min="5" max="180" required></label>
      <label>Language <select id="language" name="language"><option value="en">English</option><option value="zh">中文</option></select></label>
      <label>OS <select id="os" name="os"><option>ios</option><option>android</option><option>macos</option><option>windows</option></select></label>
      <label>Browser <select id="browser" name="browser"><option>safari</option><option>chrome</option><option>edge</option></select></label>
      <label>Form factor <select id="formFactor" name="formFactor"><option>phone</option><option>tablet</option><option>desktop</option></select></label>
      <button id="joinLab" type="submit">Join lab</button>
    </form>
    <section aria-label="Stream controls"><button id="startStream" disabled>Start Stream</button><button id="stopStream" disabled>Stop Stream</button></section>
    <section aria-label="Test controls"><label>Mode <select id="rallyMode"><option value="double">Double</option><option value="triple">Triple</option></select></label><label>Delay <select id="delayMs"><option value="300000">5 minutes</option><option value="900000">15 minutes</option><option value="3600000">60 minutes</option><option value="10800000">180 minutes</option></select></label><label>Kingdom <select id="kingdom"><option value="1">1</option><option value="2">2</option></select></label><label>Target player IDs <input id="targetPids" placeholder="Double: 2 IDs · Triple: 3 IDs"></label><button id="armTest" disabled>Arm synthetic test</button><button id="cancelTest" disabled>Cancel test</button></section>
    <section aria-label="Evidence controls"><button id="saveObservation" disabled>Save audible observation</button><button id="killRoom" disabled>Kill this QA room</button></section>
    <output id="status" aria-live="polite">Not joined</output>
  </main>
  <script src="/app.js"></script>
  <script src="/lab/audio-stream.js"></script>
</body>
</html>
```

The implementation may add bounded enum inputs required by the evidence schema, but may not remove or rename the IDs above. Do not include a manifest, service worker, autoplay attribute, hidden audio tag with `src`, operational room examples, or navigation link. `audio-stream.css` may style this page only and must not import ordinary app CSS.

- [ ] **Step 4: Implement client validation, session, and explicit start**

At module evaluation:

1. Parse `room` from the URL and apply the same bounded QA syntax client-side before any network call. The server Reliable validator remains authoritative.
2. Require `window.getRoomDeviceId`; if absent, show `Core prerequisite missing` and stop. Never fall back to a new UUID/local-storage key.
3. Populate coarse platform choices from explicit user selection; do not store/send a full UA.
4. Join only from its button. POST exact profile/password data to `/session?room=...`, retaining no password after the request resolves.
5. Keep the returned session facts in memory; authentication itself is the HttpOnly cookie.
6. Arm reads `#rallyMode`; it sends exactly two unique PIDs for Double or three for Triple and rejects any other count before network access. The server still revalidates canonical enrolled roles.

The Start handler must set `userStarted = true`, `userPaused = false`, call `replaceAudio()`, assign the same-origin stream URL, and call `audio.play()` before any `await`, timer, or fetch. Use `preload = 'none'`. The server response contains identity through the cookie; never put pid/device/token in the media URL.

- [ ] **Step 5: Implement media lifecycle, optional Media Session, and metadata**

Use these exact reconnect rules:

```js
const RETRY_MS = [1000, 2000, 4000, 8000];
const MAX_RETRIES_PER_MINUTE = 4;
```

Track attempt timestamps and connection epochs. A stale element callback whose epoch is not current returns immediately. `NotAllowedError` clears `userStarted`; `AbortError` from deliberate teardown is silent; other media errors schedule the next bounded attempt only when allowed. A fifth failure waits for another explicit Start.

Install Media Session only when the API exists. Metadata is exactly title `KvK audio stream QA`, artist `Synthetic reliability experiment`, album `Kingshoter lab`; artwork is empty. Play/pause handlers call the same explicit lifecycle, and action-handler failures do not affect audio. Capability absence changes controls/status only, never transport.

Open the lab WebSocket after Join. Its command handler compares `Date.now()` with `audioExpiresAtMs` and sends only `audioStreamLabAck`; it must not call Start, replace audio, set a timeout, or inspect cue names. Reconnect this socket independently.

Post diagnostic media events at most once per five seconds. `currentTime` is rounded to 100 ms, `bufferedAheadMs` is clamped, visibility is an enum, and errors are mapped to the allowed enum. Do not send room/profile fields already known to the session.

- [ ] **Step 6: Add local-only guarded integration**

In `test/audio-stream-lab.e2e.cjs`, use the shared helper unchanged:

```js
const room = makeQaRoom({ title: 'battle audio stream local integration' });
assertQaRoomName(room);
await installQaWebSocketGuard(context, room, {
  shouldDropClientMessage: () => false,
  shouldDropServerMessage: () => false
});
const url = new URL('/lab/audio-stream.html', baseURL);
url.searchParams.set('room', room); // qaRoomUrl is intentionally not used: it always targets /kvk.html
```

Install a second test-local `context.routeWebSocket(/\/api\/lab\/audio-stream\/socket/)` that rejects any socket whose `room` query is not the exact generated room, then transparently connects the valid socket. Do not extend or overwrite the shared helper to add this lab route.

Generate the QA password with `crypto.randomBytes(24).toString('base64url')`. Enroll separate BrowserContexts as main/weak/weak2 plus ineligible commander/member, all with distinct Core device IDs. Click Start on the three captains, arm a local-only five-second Triple job, and assert:

- all three eligible `/stream` responses are `audio/mpeg` and remain open; commander/member cannot open an eligible stream;
- command metadata has one ID, three directed targets, equal weak/weak2 landings, Main one second later, and correct personal fire times;
- commander/member receive no command metadata or cue insertion;
- byte counters increase without a metadata socket dependency;
- a forced first stream disconnect reconnects with a new epoch and no past cue record;
- Stop ends reconnect attempts;
- a non-QA URL never contacts `/api/lab/audio-stream/`;
- loading ordinary `/kvk.html?room=<fresh QA room>` produces no Stream API traffic or UI.

Do not call `qaRoomUrl` for the hidden page, and do not describe the browser run as audible/background/physical evidence.

Create `scripts/run-audio-stream-e2e.mjs` so the gate is independently executable by both this leaf and the master plan:

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const baseURL = 'http://127.0.0.1:8799';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const server = spawn(npx, [
  'wrangler', 'dev', '--local', '--port', '8799',
  '--var', 'AUDIO_STREAM_LAB_ENABLED:1',
  '--var', 'AUDIO_STREAM_LAB_ALLOW_SHORT_DELAYS:1'
], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`wrangler_exited_${server.exitCode}`);
    try { if ((await fetch(`${baseURL}/api/time`)).ok) return; } catch (error) {}
    await wait(250);
  }
  throw new Error('wrangler_ready_timeout');
}

async function runTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/audio-stream-lab.e2e.cjs'], {
      cwd, stdio: 'inherit', env: { ...process.env, AUDIO_STREAM_BASE_URL: baseURL }
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code == null ? 1 : code));
  });
}

let code = 1;
try {
  await ready();
  code = await runTest();
} finally {
  if (server.exitCode == null) server.kill('SIGTERM');
}
process.exitCode = code;
```

Add the package script without overwriting existing ones:

```json
"test:audio-stream-e2e": "node scripts/run-audio-stream-e2e.mjs"
```

- [ ] **Step 7: Run RED-to-GREEN local verification**

Run one self-contained gate; it owns the local server lifecycle and never reuses an existing process:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-client.test.cjs
npm run test:audio-stream-e2e
```

Expected: client unit tests pass; e2e uses only a fresh `qa-kvk-*` room; two streams receive one immutable synthetic job; ordinary KvK has zero Stream traffic. If local FFmpeg playback is inaudible, debug locally but do not weaken browser-gesture or expiry gates.

- [ ] **Step 8: Scope, detect, and commit Task 6**

Stage exactly the three public lab files, two test files, the isolated E2E runner, and `package.json`. Run `gitnexus_detect_changes(scope="staged")`. Expected: a hidden lab-page flow only; no ordinary KvK execution flow. Commit:

```bash
git commit -m "feat: add explicit battle stream QA client"
```

---

### Task 7: Define the physical reliability and resource matrix

**Files:**
- Create: `kingshoter/docs/qa/kvk-audio-stream-lab.md`
- Create: `kingshoter/test/audio-stream-lab-runbook.test.cjs`

**Interfaces:**
- Produces: a reproducible evidence ID per trial, paired Classic/Stream observations, platform exclusions, resource measurements, and an explicit continue/cut decision.
- Does not produce: rollout authorization, production audio ownership, an ordinary-user warning, or proof from automation.

- [ ] **Step 1: Write a failing runbook contract test**

The test reads the Markdown and requires literal coverage of:

- iOS Safari and Home Screen shortcut; Android Chrome; macOS Safari/Chrome; Windows Edge/Chrome;
- foreground, browser background with Kingshot foreground, lock screen, low-power/battery-saver, Wi-Fi↔cellular/network loss, call/audio focus, Bluetooth route change, browser restart, and desktop sleep/wake where applicable;
- server-to-speaker latency, jitter, wrong-player silence, commander/member silence, duplicates, reconnect, expiry, game audio ducking/muting, bytes, battery, heat, and DO/egress cost;
- 5/15/60/180-minute server-owned trials;
- paired Classic baseline, intentional one-time Classic+Stream overlap, kill, delete, and no-promotion language;
- explicit thresholds below and a table that has result, evidence ID, observer, device/OS/browser version, state, expected/observed GO, and notes code.

Run the test now. Expected RED because the runbook does not exist.

- [ ] **Step 2: Write the exact device/state matrix**

Create `docs/qa/kvk-audio-stream-lab.md` with these minimum rows, each repeated 10 times at 5 minutes before longer delays:

| Platform | Browser/surface | Foreground | Kingshot foreground | Lock screen | Network/audio-focus additions |
|---|---|---:|---:|---:|---|
| iOS current and previous major | Safari tab | 10 | 10 | 10 | Wi-Fi↔cellular, Low Power, call, Bluetooth |
| iOS current | Home Screen shortcut | 10 | 10 | 10 | same; this is not a PWA claim |
| Android current and previous major | Chrome tab | 10 | 10 | 10 | Wi-Fi↔cellular, Battery Saver/Doze, call, Bluetooth |
| macOS current | Safari | 10 | 10 | lock screen 10 | sleep/wake and network loss |
| macOS current | Chrome | 10 | 10 | lock screen 10 | Energy Saver, sleep/wake |
| Windows 11 current | Edge | 10 | 10 | lock screen 10 | Efficiency mode, sleep/wake |
| Windows 11 current | Chrome | 10 | 10 | lock screen 10 | Energy Saver, sleep/wake |

For every Stream trial, run a separate paired Classic trial on the same device/build/network/state with `deliveryShadow` omitted. Classic is the baseline and remains the only production path. Do not run both audio owners together except one labeled interference trial per platform that records expected duplicate audio and whether the continuous stream ducks/stops game or Classic sound.

After 5-minute screening passes, run at least three trials per platform/state at 15, 60, and 180 minutes. All are armed by the server endpoint; screenshots or recordings must show the server job ID and absolute expected fire time before the app is backgrounded.

- [ ] **Step 3: Define measurement procedure and truth hierarchy**

Use a second synchronized camera/recorder or an external microphone plus a visible reference clock. Measure `heardAtMs - fireAtMs`; do not use client ACK or telemetry as the speaker timestamp. Record median, p95, max absolute error, and jitter range by cell. A human observer marks wrong-player, duplicate, stale-after-expiry, cut-off, and recovery-after-unlock.

Truth order is:

1. external audible observation/video;
2. authenticated human evidence entry;
3. server byte/connection facts;
4. client media telemetry;
5. metadata ACK.

Lower levels may diagnose but never overrule a higher-level failure.

Measure data from server byte counters and OS network tools. Raw target is 21.6 MB/device-hour; hard limit is 25 MB/device-hour. For resource testing, run paired three-hour Classic and Stream sessions from the same starting battery band, brightness, network, and game activity. Reject if Stream consumes more than five additional battery percentage points, triggers any thermal warning, raises stabilized surface temperature more than 5°C over paired Classic, or holds game audio muted/ducked for more than two seconds after a cue.

Record Durable Object duration, requests, and egress for six concurrent streams; calculate cost per 100 devices for a three-hour battle. Cost is evidence, not permission to exceed six lab streams.

- [ ] **Step 4: Apply non-negotiable cut gates**

The candidate fails immediately on any of:

- one stale GO/number after expiry, one duplicate within Stream, wrong-player audio, or commander/member audio;
- browser playback beginning without explicit user action;
- persistent game audio interruption, call/Bluetooth recovery requiring page reload, or OS thermal warning;
- payload above 25 MB/device-hour or battery/temperature limits above;
- server-to-speaker absolute error over 500 ms in foreground or over 1,000 ms in a claimed background/lock cell;
- fewer than 9/10 correct GO observations in any platform/state the candidate claims to support;
- no clear improvement over paired Classic: Stream must add at least two successes per ten trials in at least one background/lock cell while not regressing any claimed foreground cell;
- any requirement for UA-selected transport, alternate codec/pipeline, native wrapper, service worker, or per-platform audio scheduler.

A platform may be excluded only when the same implementation remains useful on the supported set, exclusion is capability/evidence-based rather than UA routing, and the runbook records the lost audience. If more than one platform family must be excluded, or exclusion adds ongoing branching, delete the entire candidate.

- [ ] **Step 5: Define the evidence status and decision record**

Every cell is `NOT RUN`, `PASS`, `FAIL`, or `INVALID`; blank is never pass. `INVALID` requires a reason and rerun. The top of the runbook remains:

```text
Candidate status: NOT VALIDATED
Classic status: ONLY PRODUCTION AUDIO AUTHORITY
Promotion authorized: NO
```

Only after every claimed cell and resource gate passes may status become `LAB EVIDENCE PASSED`; this still does not promote Stream. A new design review must decide whether any product work is warranted.

- [ ] **Step 6: Add room/global kill and deletion rehearsal**

Document and dry-run locally:

```bash
# Room kill: authenticated session + password re-entry, closes streams immediately.
curl -i -X POST "$BASE/api/lab/audio-stream/kill?room=$ROOM" \
  -H "Origin: $BASE" -H "Content-Type: application/json" \
  -H "Cookie: kvk_audio_stream_session=$SESSION" \
  --data "{\"password\":\"$QA_PASSWORD\"}"

# Verify killed room refuses new media.
curl -i "$BASE/api/lab/audio-stream/stream?room=$ROOM" \
  -H "Cookie: kvk_audio_stream_session=$SESSION"
```

Expected: kill returns 200 only with valid re-authentication; existing streams end; later stream returns 410. Never put real secrets in committed shell history/evidence.

Global stop is a two-part bounded procedure; the router flag alone is never described as terminating an existing HTTP response. Under the implementation task's recorded deployment authority: (1) enumerate every active QA room created in the current enabled window from the private operator ledger, authenticate `POST /kill` for each, and verify every corresponding stream reader reaches EOF; (2) set `AUDIO_STREAM_LAB_ENABLED=0`, deploy, and verify new API lookups return 404 without a Durable Object lookup. Then leave Classic tests green. If any active room cannot be authenticated and killed, treat the stop rehearsal as failed and do not claim a global kill. If remote deployment is outside that execution scope, the local room-kill plus disabled-router dry run is the terminal step. The runbook must name an operator and a second verifier before any enabled remote test.

- [ ] **Step 7: Run GREEN and commit the runbook**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
node --test test/audio-stream-lab-runbook.test.cjs
```

Expected: pass when every required cell, threshold, kill/deletion procedure, status enum, and no-promotion rule is present. Cells may honestly begin as `NOT RUN`; the contract must reject blank or fabricated PASS values. Stage the two Task 7 paths, run `gitnexus_detect_changes(scope="staged")` (documentation/test only), and commit:

```bash
git commit -m "docs: define battle stream physical QA gates"
```

---

### Task 8: Verify disabled-first delivery, run evidence, and enforce keep-or-delete

**Files:**
- Verify: every file in Tasks 1–7
- Modify only if a test exposes a defect: the owning task's isolated files and tests
- On failed candidate deletion: remove all isolated Stream files listed below; modify `src/worker.js`, `wrangler.toml`, and `package.json` only as specified

- [ ] **Step 1: Run the complete automated verification from a clean staged state**

Run:

```bash
cd $KVK_WORKTREE/kingshoter
git status --short
npm run build:audio-stream-assets
npm run test:audio-stream-lab
npm test
npx wrangler deploy --dry-run --outdir /tmp/kingshoter-audio-stream-final
git diff --check
```

Expected: deterministic asset rebuild makes no diff; all lab and repository tests pass; bundle succeeds; ordinary KvK source is unchanged. If another plan added tests/bindings, include them rather than reverting them.

Start local Wrangler with the two explicit lab flags and run `npm run test:audio-stream-e2e`. Expected: fresh QA-only room, random password, no protected-room connection, no physical reliability claim.

- [ ] **Step 2: Recheck the final graph scope before any deploy**

With only Stream implementation paths staged, run `gitnexus_detect_changes(scope="staged")`. Expected affected flows:

- Worker request → fail-closed lab router → `AudioStreamLab`;
- lab session → authenticated native media response;
- lab arm → DO alarm → immutable per-device scheduler → media bytes;
- lab metadata/evidence/kill.

Unexpected and blocking: `Room` Fire/alarm/state, `kvk.js` countdown/audio, ordinary page bootstrap, Reliable delivery retry/ACK, Push lab, gift, or codes flows. Investigate and remove the coupling before proceeding.

- [ ] **Step 3: Deploy disabled first under recorded deployment authority**

When remote deployment is already authorized by the implementation task, deploy the committed config with `AUDIO_STREAM_LAB_ENABLED="0"` and `AUDIO_STREAM_LAB_ALLOW_SHORT_DELAYS="0"`. Otherwise stop successfully after the dry run; this plan does not require a new user choice:

```bash
cd $KVK_WORKTREE/kingshoter
npx wrangler deploy
curl -i "https://kingshoter.com/api/lab/audio-stream/status?room=qa-kvk-disabled-check"
```

Expected: deploy succeeds; API returns 404 with no DO lookup; ordinary KvK smoke test produces Classic audio and no Stream UI/traffic. This validates the kill switch and binding, not the candidate.

- [ ] **Step 4: Enable only a bounded QA window**

Within an already authorized QA deployment window, a named operator enables `AUDIO_STREAM_LAB_ENABLED=1`; keep short delays off. Create fresh random rooms/passwords, record every active room and kill credential in the private bounded-window ledger, enroll at most six streams, and run 5/15/60/180-minute jobs from Task 7. Every room passes the same canonical QA validator; there is no named-room branch. End the window by authenticating room kill for every ledger entry and verifying EOF first, then setting the flag back to 0 and verifying new API requests return 404 even if testing appears successful.

- [ ] **Step 5: Make the evidence decision without promotion**

If every claimed physical/resource gate passes, record `LAB EVIDENCE PASSED`, keep the lab default-disabled, and open a new design review. Do not link it, switch Classic, add a warning, or interpret this plan as rollout authorization.

If any hard gate fails, any claimed platform has timing/survival failure, resource cost is unreasonable, game audio is interfered with, or Stream has no clear advantage over Classic, set `CANDIDATE REJECTED`, execute room/global stop immediately, export only privacy-reviewed evidence to the approved private location, and proceed to deletion. If physical devices are unavailable, record `KEEP_DISABLED_FOR_PHYSICAL_QA`; this completes the automated implementation phase without completing or implying the evidence phase, and the lab stays off and unlinked.

- [ ] **Step 6: Delete a rejected candidate completely and safely**

Before editing existing Worker/config symbols, run upstream `gitnexus_impact` and warn on HIGH/CRITICAL. Remove:

```text
src/labs/audio-stream/
scripts/build-audio-stream-assets.mjs
scripts/run-audio-stream-e2e.mjs
public/lab/audio-stream.html
public/lab/audio-stream.css
public/lab/audio-stream.js
public/lab/audio-stream-assets/
test/audio-stream-lab-*.test.cjs
test/audio-stream-lab.e2e.cjs
test/support/audio-stream-lab-fakes.cjs
docs/qa/kvk-audio-stream-lab.md
```

From `src/worker.js`, remove only the Stream router import/branch and `AudioStreamLab` export. From `package.json`, remove only the three Stream scripts. From `wrangler.toml`, remove the `AUDIO_STREAM_LAB` binding and Stream flags, but preserve all prior bindings and the historical add migration. Append a unique later migration:

```toml
[[migrations]]
tag = "audiostreamlab-delete-20260713-1"
deleted_classes = ["AudioStreamLab"]
```

Verify the exact deletion tag is unused; if it has been used, stop and use the next reviewed unique numeric suffix rather than rewriting migration history. Deploy deletion only when remote deployment is already in execution scope. Then confirm API 404, no static lab page, no open stream, no Stream identifier in ordinary pages, and Classic full tests green. Remove any local/remote lab secrets or vars after the deleting deployment. Never delete or edit the shared QA helper, room harness, `src/delivery.js`, Reliable files, Push files, or core device identity.

- [ ] **Step 7: Final verification and commit discipline**

Whether retaining default-disabled lab code or deleting a rejected candidate:

```bash
cd $KVK_WORKTREE/kingshoter
npm test
npx wrangler deploy --dry-run --outdir /tmp/kingshoter-audio-stream-decision
git diff --check
git status --short
```

Before the final implementation/deletion commit, stage only expected paths and run `gitnexus_detect_changes(scope="staged")`. For retention, expected scope is isolated lab flows only. For deletion, expected scope removes only those flows and leaves Classic/Reliable/Push intact. Commit with the evidence-backed result, for example:

```bash
git commit -m "chore: keep audio stream lab disabled after QA"
# or
git commit -m "revert: delete failed battle audio stream candidate"
```

- [ ] **Step 8: Record the final invariant**

The handoff must state all four facts explicitly:

1. Classic is still the only production audio authority.
2. Ordinary KvK has no Stream UI, warning, or traffic.
3. Stream is default-disabled or deleted.
4. Physical evidence is attached with failures included; automation was not presented as mobile/background proof.

The automated implementation phase may be marked `READY_FOR_PHYSICAL_QA` when all automated tests, default-off routing, local room-kill, independent E2E runner, and dry-run gates pass while every unavailable physical cell remains explicitly `NOT RUN`. Do not mark the evidence phase `LAB EVIDENCE PASSED`, promote the candidate, or retain a rejected candidate while any required physical cell, active-room kill, decision, or rejected-candidate deletion remains unresolved.
