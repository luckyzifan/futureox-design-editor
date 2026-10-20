export const PREFIX: string
export function sanitizeFields(value: unknown): Record<string, number>
export function sanitizeRecord(value: unknown): Record<string, number|string>|null
export function createRenderDiagnostics(options?: {enabled?:boolean;detail?:boolean;batchSink?:(records:Record<string,number|string>[])=>void;session?:number;source?:string;sink?:(record:Record<string,number|string>)=>void;now?:()=>number;schedule?:typeof setTimeout;cancel?:typeof clearTimeout}): {enabled:boolean;detail:boolean;record(event:string,values?:unknown):void;flush():void;close():void}
export function setGpuDiagnosticSink(sink:((event:string,fields:unknown)=>void)|undefined):void
export function recordGpuDiagnostic(event:string,fields:unknown):void
export function gpuDiagnosticsEnabled():boolean

export function setGpuDiagnosticsDetail(value:boolean):void
export function gpuDiagnosticsDetail():boolean
export function sanitizeBatch(value:unknown):Record<string,number|string>[]

export function renderRequestCategories(payload:unknown):Record<string,number|boolean>
export function renderResultReason(error:unknown):number
