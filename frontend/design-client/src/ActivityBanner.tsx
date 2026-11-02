import type { ReactNode } from 'react'
import type { ActivityKind } from './activity-chrome'

/** One shared status for kernel boot, file open, and import. The track runs only while this is mounted. */
export function ActivityBanner({ activity, label, children }: { activity: ActivityKind; label: string; children?: ReactNode }) {
  return <div className="document-transition activity-banner" data-activity={activity} role="status">
    <img className="activity-mark" src="/branding/futureox-desgin.svg" width="22" height="22" alt="" />
    <span className="activity-copy">{label}</span>
    {children}
    <span className="activity-track" aria-hidden="true"><i /></span>
  </div>
}

export function EmptyCanvas({ title, body }: { title: string; body: string }) {
  return <div className="canvas-empty" data-activity="ready">
    <img src="/branding/futureox-desgin.svg" width="44" height="44" alt="" />
    <strong>{title}</strong>
    <span>{body}</span>
  </div>
}
