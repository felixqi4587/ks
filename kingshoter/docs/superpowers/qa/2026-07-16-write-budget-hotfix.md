# Durable Object Write-Budget Hotfix Evidence

## Release identity

- Git commit: `a730f510738fb9092a01c4a135aa40c345fa7faa`
- Browser/server build: `2026071603`
- Previous QA version: `b12b7479-a603-4f99-871d-6c07c22311c4`
- QA version: `2c2286d1-65c3-4e52-8d55-fbe796e0f116`
- Previous production rollback version: `42101b01-fe1d-4639-9c1f-be7ab234bc84`
- Production version: `d6fdf5bc-9b63-4cec-a3ea-4123fe0d572e`

## Automated gates

- Full unit/integration suite: 412/412 passed.
- Delivery suite: 125/125 passed.
- Double/Triple suite: 193/193 passed.
- Chromium core and compatibility flow: passed.
- Firefox core and compatibility flow: passed.
- WebKit core and compatibility flow: passed.
- Two-page audio-carrier long-run: passed.
- One hundred initialized sockets across heartbeat rounds: zero canonical rows after steady state.
- One hundred live bindings beyond the prior 70-second canonical TTL: zero periodic canonical writes.
- Idle ready sockets: zero recurring probe-alarm writes.
- Duplicate valid readiness: saved acknowledgement retained with zero canonical write and zero full-room broadcast.

## Fixed QA smoke

Only the isolated QA Worker and fixed room `qa` were mutated. Two independent 390px browser contexts registered test profiles, enabled alerts, and stayed open together. Both displayed `2 online`; each sent exactly one stable green `deviceStatus`, each received exactly one green `deviceStatusSaved`, and neither emitted a red transition after green during the observation window. Both pages had zero uncaught errors.

## Production smoke

Production checks were read-only and did not open a room WebSocket. `/api/build` returned current/minimum/Triple build `2026071603`, the public HTML referenced only `2026071603` first-party assets, and the custom-domain root returned HTTP 200. The preceding production version remains available for immediate rollback.
