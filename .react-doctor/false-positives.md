# React Doctor false positives / intentional exceptions

Predicates observed in source; do not “fix” these without changing product
semantics.

## `react-doctor/react-in-jsx-scope` — off project-wide

`packages/core` compiles with `"jsx": "react-jsx"` (automatic runtime). The classic
`React` import is unused; the rule does not apply. Set to `"off"` in
`doctor.config.json`.

## `react-doctor/async-await-in-loop` — sequential by design

Inline `react-doctor-disable-next-line` (and matching `ignore.overrides`):

- `packages/core/src/mutation/offlineQueue.ts` (`flush`): mutations must run in
  queue order so `dependsOn` and temp-id remapping stay correct.
- `packages/core/src/sync/selectiveSync.ts` (`syncAllByPriority`): documented to
  fetch sequentially by priority to avoid saturating the server.

## `react-doctor/server-sequential-independent-await` — type probe only

Inline suppression in `packages/core/src/types.check.ts`: compile-time assertion
file; never executed. A sequential `await` here is not runtime product code.
