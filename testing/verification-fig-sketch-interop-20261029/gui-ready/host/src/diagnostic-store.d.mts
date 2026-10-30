export interface DiagnosticRecord {time:number; severity:'error'|'warning'; component:string; code:string; requestId?:string}
export interface DiagnosticSnapshot {records:DiagnosticRecord[]; dropped:number; status:string}
export interface DiagnosticAdapter {read():string|null|Promise<string|null>; write(value:string):void|Promise<void>}
export interface DiagnosticStore {ready:Promise<void>; flush():Promise<void>; record(value:Partial<DiagnosticRecord>):string; snapshot():DiagnosticSnapshot; subscribe(listener:()=>void):()=>void; exportJSON():string}
export function createDiagnosticStore(options?:{adapter?:DiagnosticAdapter; now?:()=>number; random?:()=>Uint32Array; delay?:number}):DiagnosticStore
export function browserDiagnosticAdapter(storage:()=>Storage):DiagnosticAdapter
export function classifyDiagnostic(error:unknown):string
export function installDiagnosticHooks(target:Window, store:DiagnosticStore):()=>void
