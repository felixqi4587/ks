# Stable Manual QA Room Design

## Goal

Every test link handed to the user uses one short, predictable room:

- Room: `qa`
- Commander password: `qa`
- Origin: the isolated `kingshoter-qa` Worker

The current production domain and production rooms remain untouched.

## Approaches considered

1. **One stable manual room, isolated automated rooms — selected.** Manual phone/browser review always uses `qa` / `qa`. Automated regression continues generating temporary `qa-kvk-*` rooms so parallel runs cannot corrupt each other.
2. **One room for manual and automated tests.** Rejected because concurrent tests, expiry alarms, and stale browser sessions would overwrite the same state and make results unreliable.
3. **A short fixed room per feature.** Rejected because it still produces changing links and passwords, which is the usability problem being removed.

## Behavior

- Before a manual handoff, deploy the reviewed build to the isolated QA Worker.
- Prepare the persistent `qa` room with password `qa` and the state needed for the current review.
- Clean stale manual players, commands, and staging before a later handoff when they would interfere with the next scenario.
- Give the user only the stable `room=qa` link and the password `qa`.
- Never present automated temporary-room names as user-facing test links.

For the current Cancel Rally review, the room ends with a complete editable Double lineup restored after Fire → Cancel. This lets the user verify that Cancel no longer deletes the selected team and that the restored lineup survives reload.

## Safety and verification

- The fixed room exists only in the isolated QA Worker Durable Object namespace.
- Production routes, bindings, rooms, and data are not read or changed.
- Automated regression stays isolated in generated rooms.
- Before handoff, verify the `qa` room password, exact restored PIDs and roles, zero frozen slots, enabled Fire, reload persistence, and a second synchronized page.

