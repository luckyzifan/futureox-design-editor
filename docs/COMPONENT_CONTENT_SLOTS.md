# Free-content component slots

## Authored contract

Schema 15 adds `component.slots[slotId] = { name, targetKey }` and
`instance.slotContents[slotId] = [authoredRootIds...]`. A slot targets a frame,
group, or section inside a main component. Its existing children are fallback.
An omitted assignment uses fallback; an empty array explicitly hides fallback.
Assignments move arbitrary authored subtrees, including component instances,
into the materialized slot host. This is not an instance-swap property.

Content nodes retain their authored IDs, ordinary editability, and nested
component references. Component resolution uses the same resulting tree for
layout, picking, CPU rendering and export. Repeated resolution and binary FD
save/reopen preserve those IDs. Replacing or resetting an assignment moves old
content to its page rather than deleting it; transforms preserve its world
placement. The operation is one normal Editor transaction and undo entry.

Stable slot IDs are primary during component/variant changes. A unique matching
name can migrate a slot ID; ambiguous or missing matches reject the change.
Removing an assigned slot is rejected until its instances are reset or detached.
Deleting the source main component uses the existing detach-preserving-content
workflow.

## UI and automation

The shared Web/Electron ComponentPanel can declare a selected component
container as a named slot, list/remove declarations, and add an existing
subtree to a selected instance's slot. It also provides select-content, clear,
and restore-default actions. Ordinary content selection edits the owned tree.

The shared automation registry exposes:

- `component.declareSlot`: `nodeId`, `name`, optional `slotId`
- `component.assignSlot`: `nodeId` (instance), `slotId`, `nodeIds` (array or null)
- `component.removeSlot`: `componentId`, `slotId`

These use the existing exact operation permission policy, document/session and
revision fences, atomic batch commit and Editor history boundary. Invalid IDs,
locked ancestry/subtrees, overlapping roots and foreign slot ownership reject
without publishing a partial document.

## Deliberate boundaries

Declarations cannot overlap/nest. Assignment authoring is supported on outer
instances outside component definitions. Content may contain nested component
instances; template-owned slot assignments and nested slot ownership are not
supported. Existing document/component byte and node limits apply, plus 128
slots per component/instance and a 64-level subtree bound. Unmatched assigned
slots reject rather than silently discard user content.

## Primary references

- Figma's distinction between arbitrary slot content and instance swaps:
  https://developers.figma.com/docs/code-connect/html/
- Figma slot authoring and fallback guidance:
  https://help.figma.com/hc/en-us/articles/38231200344599-Create-and-use-slots-to-build-flexible-components-in-Figma-Design
- Named slot/fallback semantics:
  https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_templates_and_slots

## Verification entry points

- Rust: `cargo test -p futureox-design-kernel --test component_slots`
- Client: `vitest run src/component-slots.test.ts src/automation/component-slots.test.ts`

The client tests require the current generated WASM kernel. No GPU, GUI or
socket test is substituted for these CPU contracts.

Verified on integrated WASM SHA-256
`2da305a6864c783685ea6ffcd7d3978ba2df58a206c39653dd20d56689347561`:
5 native CPU tests, 10 dedicated client tests, and 78 existing component and
automation regression tests passed. The React DOM test uses the real shared
ComponentPanel and Editor under jsdom; it does not claim browser/GPU end-to-end
coverage.
