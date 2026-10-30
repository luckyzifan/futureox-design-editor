export const drawWorkLimits: Readonly<Record<string,number>>
export class PassDrawWork {
  enabled:boolean
  reset(enabled:boolean):void
  draw(mode:number,count?:number):void
  clear():void
  snapshot():Record<string,number>
}
