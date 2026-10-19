# First canvas workflow checkpoint

Historical checkpoint on 2026-10-19, before the subsequent paste-over/center-selection increment. Six matched test files contain 89 passed tests, zero failures and zero skipped tests. Vitest's suite counter includes nested describe blocks; use `testResults.length` for file count. TypeScript completed successfully; its empty log is retained.

Covered the initial keyboard dimensions, profile-aware Select All, Figma remove-auto-layout and Windows front/back changes, together with existing shortcut/DOM/hierarchy/property/smart-paste tests. This checkpoint does not assert current full-product equivalence. Later source and result provenance are recorded in `../verification-paste-over-selection/`.

Published logs/results have only machine-specific path prefixes replaced with `<REPO>` or `<DEPENDENCIES>`. Counts, assertions, outcomes and timings are unchanged. Unmodified raw originals are retained outside the checkout. `publication.sha256` recursively lists only this folder's deliverable files with folder-relative names; it does not hash product paths.

No native browser/Electron GUI, system keyboard or GPU run is claimed.
