import type { GpuScene } from '../../design-client/src/kernel/gpu/types'
export const MAX_PREVIEW_BYTES: number
export type PreviewOwner = { kernel_id: 'sketch'; document_schema: 'sketch-native-v1'; document_id: string; session_epoch: number }
export type PreviewFrame = { owner: PreviewOwner; revision: number; page_id: string; scene: GpuScene }
export function admitSketchPreview(frameJson: string, expectedOwner: PreviewOwner, expectedRevision?: number): PreviewFrame
export type SessionPreview = { owner: PreviewOwner; revision: number; pageId: string; pageCount: number; preview: import('../../design-client/src/sketch-inspection').SketchPreview }
export function admitSessionPreview(value: unknown, owner: PreviewOwner, revision: number, pageId: string): SessionPreview
