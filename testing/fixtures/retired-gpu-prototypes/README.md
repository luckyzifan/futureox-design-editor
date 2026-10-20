# Retired GPU prototype references

These four WGSL files are preserved reference sources from retired, test-only WebGPU experiments. They are not imported by the editor or copied into production assets. Their historical comments describe the original prototype and do not establish current rendering accuracy.

The point-tent prototype's arbitrary-spacing paired-fetch equivalence is not valid across bilinear-cell boundaries or nonlinear clamp transitions. Production integrated filtering is a separate implementation.

The independent browser verification page remains at `frontend/design-client/public/figma-blur-verify.html` for development use and is excluded from production copies. CPU tent and scalar-packing reference tests remain in the GPU test directory. Existing historical verification records remain unchanged.
