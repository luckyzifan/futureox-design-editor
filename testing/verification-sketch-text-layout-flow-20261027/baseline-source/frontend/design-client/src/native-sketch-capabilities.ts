import type { DesktopBridge } from './desktop'

/** Inspection alone never confers write capability. A partial/older host cannot
 * advertise a working edit session merely because it can open or preview one. */
export function nativeSketchCapabilities(bridge?: Pick<DesktopBridge, 'inspectSketch' | 'sketchSession'>) {
  const session = bridge?.sketchSession
  return {
    inspect: typeof bridge?.inspectSketch === 'function',
    edit: !!session && ['open', 'rename', 'undo', 'redo', 'status', 'close', 'saveAs', 'preview', 'leafFrame', 'setLeafFrame', 'resizeLegacyContainer', 'textTargets', 'textValue', 'setTextOverride']
      .every(method => typeof session[method as keyof typeof session] === 'function'),
  }
}

