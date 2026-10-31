export const SURFACE_SCAN_STEPS: number
export const SURFACE_SCAN_UNIQUE: number
export const SurfaceMembership: Readonly<Record<string,number>>
export const SurfaceAllocationSite: Readonly<Record<string,number>>
export type SurfaceAllocationTag = Readonly<{site:number;role:number;mode:number}>
export function surfaceAllocationRole(site:number):number
export function surfaceAllocationTag(site?:number,mode?:number):SurfaceAllocationTag
export function sanitizeSurfaceLedger(value:unknown):Record<string,number>
export function snapshotSurfaceLedger<T extends object>(input:{sources:{mask:number;items:Iterable<unknown>;nested?:boolean;surface?:boolean}[];
 aliases:(texture:T)=>number;pinned:(texture:T)=>boolean;material:(texture:T)=>boolean;coverage:(texture:T)=>boolean;
 tag:(texture:T)=>SurfaceAllocationTag|undefined;poolEpoch:(texture:T)=>number|undefined;completedEpoch:number|undefined;ledgerBytes:number}):Record<string,number>
