# Rally / Defense Release Verification

Release executed on 2026-07-17 (America/Denver).

## Release identity and rollback

- Source branch: `codex/kvk-delivery-program`
- Released source commit: `2b382b1caa0d681d08d2a324158122d739291c20`
- GitHub pre-change restore tag: `rally-defense-prechange-20260716`
- Final QA Worker version: `4d64b2ec-4455-4a30-9a72-b8df3e9d6d97`
- Previous production version: `80640bd5-4064-446a-895b-a4189cee6419`
- New production version: `f119b5b0-216a-4758-b629-0c5957eda708`
- Production deployment status: 100% traffic on the new version

Immediately before promotion, Wrangler reported 100% production traffic on the
recorded previous version. The released branch and the immutable pre-change tag
were both present on GitHub before production deployment.

## Local release gates

| Gate | Result |
| --- | --- |
| `npm test` | 786/786 pass |
| `npm run test:delivery` | 136/136 pass |
| `npm run test:triple` | 214/214 pass |
| `npm run test:rally-defense` | 297/297 pass |
| `npm run test:load:defense` | Pass: 150 registered profiles, 100 targeted website profiles, 102 Defense sockets at Fire, 20 reconnects, 1 accepted revision |
| `npm run test:rally-core:all` | Chromium, Firefox, and WebKit pass |
| Supporting-page and coordination browser gate | Chromium, Firefox, and WebKit pass at mobile widths, 200% text, focus, preferences, isolation, and silent-manager scenarios |
| Local `npm run test:qa:rally-defense` | 24/24 pass |
| Remote `npm run test:qa:rally-defense` | 24/24 pass against the exact QA origin |
| QA navigation hardening | 3/3 unit pass; target Classic rollback 3/3 browser engines |

The load result is website delivery evidence only. It is not a count of players
who acted in Kingshot.

## QA and production artifact checks

- Both dry runs read 46 static files.
- QA bindings: the existing `ROOM` Durable Object and `ASSETS` binding.
- Production bindings: the existing `ROOM` Durable Object, `ASSETS`, and
  existing `GIFT_KV` namespace.
- The existing `Room` Durable Object class/migration is unchanged.
- Triple Rally is enabled for all rooms; Double remains the default mode.
- No Admin surface, gameauto integration, room-password modification endpoint,
  new Durable Object class, or new KV namespace was shipped.
- QA used only the fixed room `qa`, with password `qa`.

## Production read-only smoke

No production room was entered, no WebSocket was opened, and no Rally or
Defense command was sent.

| Check | Result |
| --- | --- |
| `/api/build` | 200; build metadata valid; Triple enabled |
| `/` | 200 HTML; canonical Rally and Defense links present |
| `/rally` | 200 HTML; Rally controller, shared audio, and tactical assets present |
| `/defense` | 200 HTML; Defense controller, shared audio, and virtual-list assets present |
| `/kvk?lang=en` | 302 to `/rally?lang=en` with `no-store` |
| Deployment status | `f119b5b0-216a-4758-b629-0c5957eda708` at 100% |

Right after deployment, one custom-domain `/defense` probe briefly returned an
empty 404 while the workers.dev route already returned 200. A cache-busted probe,
an ordinary GET, and a later HEAD all returned 200, consistent with Cloudflare
edge propagation rather than an application routing defect.

## GitNexus scope review

The final compare against `rally-defense-prechange-20260716` is intentionally
classified `CRITICAL`: 4,725 changed symbols, 263 affected processes, and 155
files. The affected scope matches the approved master plan: shared connection,
clock, audio, status, cue, identity, delivery, and drawer modules; Rally naming
and legacy redirects; isolated Defense protocol/state/UI; Triple and player
management; supporting-page UI; Durable Object write-budget behavior; build
gates; load and multi-browser tests. This is a broad product release, not a
small patch, so the complete gates above are part of the release evidence.

## Rollback command

If a critical production regression is confirmed, roll back to the verified
surface-fence version:

```sh
npx wrangler rollback 80640bd5-4064-446a-895b-a4189cee6419 --name kingshoter --message "Rollback Rally Defense"
```

After rollback, verify `/api/build`, `/rally`, `/defense`, and the legacy `/kvk`
redirect without entering any production room.
