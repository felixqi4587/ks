# KvK Compact Ready Copy Design

## Goal

Remove the redundant idle confirmation sentence below the player's identity card and keep the healthy audio-status message on one visual line on narrow phones.

## Approved behavior

- Remove the `#idleWait` element and its two unused translation literals. The player identity chip remains the only idle-ready confirmation.
- Shorten the healthy audio copy to:
  - English: `🔊 Alerts on · switch to game`
  - Chinese: `🔊 提醒已开启 · 可切回游戏`
- Preserve the existing platform suffix (`iOS`, `Android`, or `Desktop`).
- Keep `.astat` at its existing 12px/800 typography and add no-wrap with an ellipsis fallback.
- Do not change warning copy, audio health detection, resume behavior, countdown scheduling, alert delivery, WebSocket behavior, Fire, Defense, or commander behavior.

## Risk containment

GitNexus rates `paintAudioStatus` CRITICAL and `paintHero` HIGH because they participate in audio, countdown, room-state, and rendering flows. This change therefore does not edit either function. It removes one null-safe DOM target, removes its now-unused translations, changes only the healthy-status translation literals, and adds a static CSS layout constraint.

## QA release

Deploy a dedicated `kingshoter-qa` Worker on its workers.dev origin. Its configuration must contain only the application entry point, static assets, Triple feature variables, and its own `Room` Durable Object migration. It must not contain the `kingshoter.com` route, cron triggers, production `GIFT_KV`, or production secrets. Do not upload the candidate as a Version of the production `kingshoter` service because that can still bind production Durable Objects.

Use a newly generated `qa-kvk-*` room in the QA Worker's isolated Durable Object namespace for phone testing. Because this is the first deployment of a unique QA origin, keep build `2026071505` during QA; a later production rollout must receive a new forced-refresh build.

## Verification

- Static regression test proves `#idleWait` is absent, both healthy-status strings are compact, and `.astat` is no-wrap.
- Focused test is observed failing before implementation and passing afterward.
- Full unit, Triple, and Delivery suites pass.
- A static safety test proves the QA Worker config has no production routes, crons, KV namespaces, or service binding.
- The online QA Worker responds successfully and its assets contain the new copy with no idle element.
