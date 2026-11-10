import type { UiMode } from './interface-preference'

/** Which local-file surface the persistent chrome controls open. */
export type LibraryHostKind = 'web' | 'desktop-files' | 'desktop-workspace'

/** Desktop workspace, desktop files, and the browser each keep their own surface.
 * A missing session is the browser library, including a source workspace that
 * does not own a desktop session. */
export function libraryHostKind(session: { supportsWorkspace: boolean } | null | undefined): LibraryHostKind {
  if (!session) return 'web'
  return session.supportsWorkspace ? 'desktop-workspace' : 'desktop-files'
}

/** Whether the left rail “文件” control is mounted.
 *
 * Figma workspace chrome shows that control next to the header “本机设计”
 * button, and both open the same local library. That pair drops the rail
 * control and keeps the header as the one persistent entry. Sketch hides the
 * whole rail and still uses the header, so its rail control stays mounted.
 * Desktop-files and web keep the rail control on their own surfaces (project
 * catalog and browser library). Those surfaces are not the workspace library.
 *
 * This is shell presentation. Canvas compile/draw stays on
 * `DesignKernel.compile_gpu`; asking WASM which button to paint would add a
 * boundary crossing and would not change a pixel. */
export function libraryRailVisible(layout: UiMode, host: LibraryHostKind): boolean {
  return !(layout === 'figma' && host === 'desktop-workspace')
}
