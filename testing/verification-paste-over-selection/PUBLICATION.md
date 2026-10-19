# Evidence publication note

This folder contains the frozen scoped source identities, prior-delivery preimages needed for the isolated negative control, executable reproduction script, reports and test logs/results. Product paths appear only inside provenance records; `publication.sha256` itself is recursive and folder-local.

Published logs/results replace machine-specific prefixes with `<REPO>`, `<OLD_CODE_ISOLATED>`, `<DEPENDENCIES>` or `<NEGATIVE_TEMP>`. Assertions, test statuses/counts and timings are unchanged. Unmodified raw originals are retained outside the checkout. The reproduction script computes its paths at runtime and does not depend on those placeholders.

The old-code negative run selects nine named behavior witnesses. Its other 38 tests are intentionally filtered by the test-name selector, not product skips. Positive affected 169/169 and final focused 47/47 runs have zero skipped tests. Native module results are a separate test run and are documented in the native evidence folder.

No product source or product test was edited during packaging.
