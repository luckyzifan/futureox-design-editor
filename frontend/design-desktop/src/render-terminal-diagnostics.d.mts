export const PREFIX: string
export function sanitizeFields(value: unknown): Record<string, number>
export function sanitizeRecord(value: unknown): Record<string, number|string>|null
export function createRenderDiagnostics(options?: {enabled?:boolean;session?:number;source?:string;sink?:(record:Record<string,number|string>)=>void;now?:()=>number;schedule?:typeof setTimeout;cancel?:typeof clearTimeout}): {enabled:boolean;record(event:string,values?:unknown):void;flush():void;close():void}
export function setGpuDiagnosticSink(sink:((event:string,fields:unknown)=>void)|undefined):void
export function recordGpuDiagnostic(event:string,fields:unknown):void
export function gpuDiagnosticsEnabled():boolean
