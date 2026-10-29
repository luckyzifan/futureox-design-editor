export const drawWorkLimits: Readonly<Record<string,number>>
export class PassDrawWork {
  enabled:boolean
  reset(enabled:boolean):void
  draw(mode:number,count?:number,pixels?:number):void
  clear():void
  snapshot():Record<string,number>
}
export const fastPathKeys:readonly string[]
export class FastPathWork {
 enabled:boolean
 reset(enabled:boolean):void
 add(key:string,count?:number):void
 snapshot():Record<string,number>
}
