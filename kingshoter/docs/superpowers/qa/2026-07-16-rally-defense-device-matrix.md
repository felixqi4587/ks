# Rally / Defense Device and Audio Matrix

Execution completed on 2026-07-17 (America/Denver). The fixed remote QA room was
`qa`, with room-manager password `qa`. No operational room was used.

## Automated browser coverage

| Surface | Engine | Viewports / conditions | Result |
| --- | --- | --- | --- |
| Rally | Chromium | 320, 375, 390, and 430 CSS px; Double/Triple; reconnect; immutable command; Classic rollback; selected and silent-manager projections | Pass |
| Rally | Firefox | Same release scenarios and narrow-layout checks | Pass |
| Rally | WebKit | Same release scenarios and narrow-layout checks | Pass |
| Defense | Chromium | Isolated surface, manager-only silence, cancellation, next-round readiness, shared cues, and QA cleanup | Pass |
| Defense | Firefox | Same release scenarios | Pass |
| Defense | WebKit | Same release scenarios | Pass |
| Supporting pages | Chromium, Firefox, WebKit | Mobile widths, 200% text, focus, reduced motion/transparency, and no horizontal overflow | Pass |

The final remote serialized gate against
`https://kingshoter-qa.kingshot1406.workers.dev` passed 24/24. The final local
serialized gate also passed 24/24. The browser suite uses only room `qa` and
cleans its Rally and Defense state.

## Audio and delivery truth

- Rally and Defense both use the shared BattleAudio and BattleCues modules.
- Automated gates cover explicit alert enablement, running AudioContext,
  carrier health, socket generation, fresh synchronized clock, T-15,
  T-10 through T-6, 5 through 1, and exact `Now` scheduling.
- An unselected Rally commander and a Defense manager-only device remain
  silent. A selected captain/defender receives only their personal schedule.
- Website delivery metrics mean only that a website device was targeted,
  scheduled, audio-ready, offline, late, or unconfirmed. The website cannot
  observe whether a person acted in the game or whether a march arrived.

## Physical-device status

| Platform | Status | Release interpretation |
| --- | --- | --- |
| iOS Safari, real device/background | Not independently executed in this release session | WebKit automation passed, but it is not proof of indefinite iOS background audio delivery. The user must still enable alerts and test the device before battle. |
| Android Chrome, real device/background | Not independently executed in this release session | Chromium automation passed, but it is not proof of indefinite Android background audio delivery. The user must still enable alerts and test the device before battle. |
| macOS browsers, real background session | Not independently executed in this release session | Desktop engine automation passed; operating-system sleep and power policy remain outside website control. |
| Windows browsers, real background session | Not independently executed in this release session | Desktop engine automation passed; operating-system sleep and power policy remain outside website control. |

No unavailable physical platform is marked as passed, and the release makes no
guarantee that a browser or operating system will keep a suspended page alive
indefinitely.

## QA anomaly and resolution

One first-pass Chromium test received a transient empty Cloudflare 404 for the
second device document. The same test then passed alone and in the complete
Chromium sequence. Trace evidence showed that the page was empty; the audio
button was not hidden or blocked. The QA navigation helper now validates HTTP
status and HTML content, retries only one navigation error/empty response/404/5xx,
requires the visible page sentinel, and limits the alert-button action to five
seconds. Unit coverage passed 3/3, and the final remote gate passed 24/24.
