import type { SketchSessionOwner, SketchSessionStatus } from '../../design-client/src/desktop'
export function sameSketchOwner(a: unknown, b: unknown): boolean
export function admitSketchSession(value: unknown, owner: SketchSessionOwner): SketchSessionStatus
export function validSketchFrame(value: unknown): value is import('../../design-client/src/desktop').SketchNativeFrame
export function validSketchTextOverride(value: unknown): value is import('../../design-client/src/desktop').SketchTextOverride
export function admitSketchLeafFrame(value: unknown, owner: SketchSessionOwner, revision: number, layerId: string): import('../../design-client/src/desktop').SketchLeafFrameStatus

export function admitSketchTextTargets(value: unknown, owner: SketchSessionOwner, revision: number, instanceId: string): import('../../design-client/src/desktop').SketchTextTargets
export function admitSketchTextValue(value: unknown, owner: SketchSessionOwner, revision: number, instanceId: string, targetPath: string): import('../../design-client/src/desktop').SketchTextValue
