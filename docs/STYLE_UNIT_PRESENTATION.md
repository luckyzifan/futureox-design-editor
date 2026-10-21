# Style-unit presentation under affine transforms

This increment labels Core's existing Inspector convention. It does not change
propertyUnits.style, numeric conversions, authored data, history, scale commands,
MCP schemas or rendering. No local-unit mode or automatic unit switch is added.

For a non-uniform or skewed world transform, marked scalar style controls retain
their maximum-singular-value conversion. The visible notice explains that this
is not a unique physical size in every direction. The input and scrub control
receive an accessible description, without changing the field's accessible name.
Mixed-value controls preserve their existing explanation and append the unit
qualification. Mixed selections report the affected subset.

Only controls currently using units.style receive the marker/description: scalar
text spacing/font size, corner distances, stroke width/dashes/offset, and the
existing scalar effect distances. Axis-specific geometry/layout/gradient lengths,
percentages and angles keep their existing meaning. Existing differences between
single/multi texture noiseSize and effect amount conversions are not changed.

The shared similarity predicate is the same one used by the optional node.get
projection. That projection continues to omit ambiguous scalar style distances;
it does not advertise the Inspector convention as Figma-equivalent values.

A pure skew matrix [1,0,1,1] has maximum singular value (1+sqrt(5))/2, not the
maximum coordinate-axis length sqrt(2). Therefore the UI says maximum scale
coefficient, not a loosely defined maximum-axis projection. Rotation/reflection
and uniform scale need no warning. Classification uses the world matrix and the
existing projection tolerance, including inherited transforms.

## Official evidence and limits

[Figma relativeTransform](https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/)
documents unit-length axes rather than matrix scale, and says skew is not exposed
in the property panel. It does not specify a maximum-singular-value rule for
style fields under skew.

[Figma text sizing](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing)
distinguishes text bounding-box resizing from the Scale tool's simultaneous
text-size and bounds scaling. Neither page establishes Core's non-uniform
Inspector convention as Figma behavior. The notice discloses that boundary.

## Acceptance

The added tests cover uniform/reflected absence of the notice, diagonal/skew
presence, world-transform composition, input labels/descriptions, unchanged
conversion/limits, mixed-value explanations and no authored/history changes.
These tests require execution against the candidate; source-only creation is not
a pass. Actual browser/Electron visual fit and focus behavior remain separate
acceptance checks. Existing pending-input/keyboard/scrub suites should also run
before integration because NumberField is shared.
