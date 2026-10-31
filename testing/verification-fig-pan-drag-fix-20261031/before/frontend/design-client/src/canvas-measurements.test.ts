import {expect,test} from 'vitest'
import {measureBounds} from './canvas-measurements'
test('nested layer measurements report all four exact margins',()=>{
 const outer={x:10,y:20,width:300,height:200},inner={x:40,y:65,width:50,height:60}
 expect(measureBounds(inner,outer).map(m=>m.distance)).toEqual([30,220,45,95])
 expect(measureBounds(outer,inner)).toEqual(measureBounds(inner,outer))
})
test('separate layers measure edge gaps without counting shape widths',()=>{
 const a={x:0,y:0,width:100,height:50},b={x:120,y:60,width:80,height:40}
 expect(measureBounds(a,b).map(m=>m.distance)).toEqual([20,10])
})
