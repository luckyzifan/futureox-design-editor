# Signed96 Y candidate — not active

The exact arithmetic candidate passed 65 targeted CPU tests and a real Metal-3
original-12-pass oracle: 11 cases, 2,598,064 raw float components, zero changes.
The complete Electron v6 workload matched all 13 RGBA comparisons and restored
the complete document on undo.

It did not establish a latency benefit over v5: first 3200% 3.627 versus 3.557 s,
held latest-input wait 1.215 versus 0.899 s. These are single matched sequential
runs, so they do not establish a general regression size. The candidate is
removed from active source because it failed to demonstrate the required gain.

The patch keeps the original final RNE, selects signed96 Y only under
P+kx+ky+2 <= 94, and otherwise uses signed128. Native CPU field analysis found
98.85% joint eligibility for the captured 117 support; eligibility was not a
whole-application performance result.

Apply the retained patch only to a matching source, rebuild and repeat the
raw-float and Electron gates before considering it again.
