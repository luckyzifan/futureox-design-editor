import { expect,test } from 'vitest'
import { node,defaultTextStyle } from './model'
import { importFigTextRuns } from './import-fig-text'
test('mixed native FIG styles preserve UTF-16 ranges, casing, alpha and font identities',()=>{
  const n=node('text');n.text='a😀CD';n.textStyle=defaultTextStyle()
  const warnings=new Set<string>()
  const fonts=importFigTextRuns(n,{fontName:{family:'Poppins',style:'SemiBold'},textData:{
    characterStyleIDs:[0,1,1,2,2],styleOverrideTable:[
      {styleID:1,fontSize:25,fontName:{family:'Poppins',style:'Bold'},textCase:'ORIGINAL'},
      {styleID:2,textCase:'LOWER',fillPaints:[{type:'SOLID',color:{r:1,g:0,b:0,a:.5},opacity:.4}],textDecoration:'UNDERLINE'},
    ]}},warnings)
  expect(n.text).toBe('a😀CD');expect(n.textStyle.weight).toBe(600)
  expect(n.textRuns).toEqual([{start:1,end:3,fontSize:25,weight:700,textCase:'original'},
    {start:3,end:5,textCase:'lower',color:'color(srgb 1 0 0 / 0.2)',underline:true}])
  expect(fonts).toEqual({style:'Poppins SemiBold',runs:{0:'Poppins Bold'}})
  expect(warnings.size).toBe(0)
})

test('per-run Figma line height and letter spacing become schema 21 metrics', () => {
  const n=node('text'); n.text='ab'; n.fontSize=20; n.textStyle=defaultTextStyle()
  const warnings=new Set<string>()
  importFigTextRuns(n,{fontSize:20,textData:{characterStyleIDs:[1,0],styleOverrideTable:[
    {styleID:1,fontSize:10,lineHeight:{units:'PIXELS',value:20},letterSpacing:{units:'PERCENT',value:10}},
  ]}},warnings)
  expect(n.textRuns?.[0]).toMatchObject({start:0,end:1,fontSize:10,lineHeight:2,letterSpacing:1})
  expect(warnings.size).toBe(0)
})
