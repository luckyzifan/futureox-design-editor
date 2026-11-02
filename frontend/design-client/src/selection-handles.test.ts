import { expect, test } from 'vitest'
import { apply, boxPoints, inverse, multiply, rotate, translate, pointInContours } from './geometry'
import { formatAngleDegrees, normalizeDegrees, selectionHandles, selectionRotation, smallSelectionInterior } from './selection-handles'
import { clockwiseDegrees, localClockwiseAfter, resizeInBasis, rotateNode, selectionLocalBounds, snapLocalClockwise } from './canvas-view'
import type { Matrix } from './model'
import {blank,node} from './model'
import {selectionScaleFrame,scaleAnchor} from './selection-scale'

test('small text keeps a movable interior under overlapping fixed-size handles',()=>{
  for(const zoom of [.122,.392])for(const angle of [0,37,-90]){
    const transform=multiply(translate(200,-40),rotate(angle))
    const corners=boxPoints({x:0,y:0,width:64,height:20}).map(p=>apply(transform,p))
    expect(smallSelectionInterior(corners,zoom,apply(transform,{x:32,y:10}))).toBe(true)
    for(const handle of selectionHandles(corners,zoom))expect(smallSelectionInterior(corners,zoom,handle.rotateAnchor)).toBe(false)
  }
  expect(smallSelectionInterior(boxPoints({x:0,y:0,width:64,height:20}),1,{x:32,y:1})).toBe(false)
})

test('four exterior rotate regions keep fixed screen size across zoom and transformed parents',()=>{
  for(const zoom of [0.25,1,4])for(const transform of [rotate(0),rotate(37),multiply(rotate(-20),[-2,0,0,3,0,0] as Matrix)]){
    const corners=boxPoints({x:0,y:0,width:120,height:80}).map(p=>apply(transform,p))
    const handles=selectionHandles(corners,zoom)
    for(const h of handles){
      expect(pointInContours(h.rotateAnchor,[h.rotatePoints],'nonzero')).toBe(true)
      expect(pointInContours(h.point,[h.rotatePoints],'nonzero')).toBe(false)
      expect(pointInContours(h.rotateAnchor,[corners],'nonzero')).toBe(false)
      expect(Math.hypot(h.rotateAnchor.x-h.point.x,h.rotateAnchor.y-h.point.y)*zoom).toBeCloseTo(Math.hypot(20,20),8)
      expect(h.resizeCursor.startsWith('url(')).toBe(true)
    }
  }
})

test('clockwise pointer motion is a positive Figma angle and the matrix follows the hand', () => {
  const center = { x: 100, y: 80 }, start = { x: 160, y: 80 }, end = { x: 100, y: 140 }
  const rotation = selectionRotation(center, start, end, 0, false)
  expect(rotation.degrees).toBeCloseTo(90, 8)
  expect(formatAngleDegrees(rotation.degrees)).toBe('90.00')
  expect(formatAngleDegrees(-6.754)).toBe('-6.75')
  expect(formatAngleDegrees(195)).toBe('-165.00')
  const turned = apply(rotation.matrix, start)
  expect(turned.x).toBeCloseTo(end.x, 8)
  expect(turned.y).toBeCloseTo(end.y, 8)
  const back = selectionRotation(center, start, { x: 100, y: 20 }, 0, false)
  expect(back.degrees).toBeCloseTo(-90, 8)
})

test('a clockwise drag stores the same positive angle the inspector reads', () => {
  const parent = multiply(translate(12, -4), rotate(20))
  const child = multiply(translate(40, 50), rotate(0))
  const world = multiply(parent, child)
  const center = apply(world, { x: 0, y: 0 })
  const start = { x: center.x + 50, y: center.y }
  const end = { x: center.x, y: center.y + 50 }
  const drag = selectionRotation(center, start, end, 0, false)
  const local = localClockwiseAfter(parent, world, drag.matrix)
  expect(drag.degrees).toBeCloseTo(90, 6)
  expect(local).toBeCloseTo(90, 6)
  expect(clockwiseDegrees(multiply(inverse(parent), multiply(drag.matrix, world)))).toBeCloseTo(local!, 8)
  const six = 6 * Math.PI / 180
  const nudged = selectionRotation(center, start, { x: center.x + 50 * Math.cos(six), y: center.y + 50 * Math.sin(six) }, 0, false)
  const turned = multiply(parent, rotate(10))
  expect(localClockwiseAfter(parent, turned, nudged.matrix)).toBeCloseTo(16, 5)
  const snapped = snapLocalClockwise(parent, turned, nudged.matrix, center)
  expect(localClockwiseAfter(parent, turned, snapped)).toBeCloseTo(15, 5)
})

test('rotation snaps the resulting orientation and preserves center and full nested matrix',()=>{
  const parent=multiply(translate(200,-40),multiply(rotate(31),[1.6,0.2,0.1,0.8,0,0]))
  const local=multiply(translate(44,90),rotate(-17)), world=multiply(parent,local)
  const center=apply(world,{x:60,y:40}),start={x:center.x+100,y:center.y}
  const angle=Math.atan2(world[1],world[0])*180/Math.PI,theta=28*Math.PI/180
  const end={x:center.x+100*Math.cos(theta),y:center.y+100*Math.sin(theta)}
  const r=selectionRotation(center,start,end,angle,true),next=multiply(inverse(parent),multiply(r.matrix,world))
  expect(r.degrees).toBeCloseTo(normalizeDegrees(Math.round((angle+28)/15)*15),8)
  expect(r.degrees%15).toBeCloseTo(0,10)
  const after=multiply(parent,next),afterCenter=apply(after,{x:60,y:40})
  expect(afterCenter.x).toBeCloseTo(center.x,10);expect(afterCenter.y).toBeCloseTo(center.y,10)
  expect(Math.hypot(after[0],after[1])).toBeCloseTo(Math.hypot(world[0],world[1]),10)
  expect(Math.hypot(after[2],after[3])).toBeCloseTo(Math.hypot(world[2],world[3]),10)
  expect(after[0]*after[3]-after[1]*after[2]).toBeCloseTo(world[0]*world[3]-world[1]*world[2],10)
})

test('edge resize changes one local dimension and keeps opposite edge in place',()=>{
  const basis=multiply(translate(60,40),rotate(37)),box={x:0,y:0,width:120.25,height:80.5}
  const start=apply(basis,{x:120.25,y:40.25}),end=apply(basis,{x:150.25,y:65.25})
  const result=resizeInBasis(basis,box,start,end,5,false,false,true)
  const moved=apply(inverse(basis),apply(result,start)),fixed=apply(basis,{x:0,y:40.25}),after=apply(result,fixed)
  expect(moved.x).toBeCloseTo(150,9);expect(moved.y).toBeCloseTo(40.25,9)
  expect(after.x).toBeCloseTo(fixed.x,9);expect(after.y).toBeCloseTo(fixed.y,9)
})

test('edge proportional shrinking and Alt center resize preserve their intended anchors',()=>{
  const basis:Matrix=[1,0,0,1,0,0],box={x:0,y:0,width:120,height:80}
  const scale=resizeInBasis(basis,box,{x:120,y:40},{x:60,y:40},5,true,false,false)
  expect(apply(scale,{x:120,y:0})).toEqual({x:60,y:20})
  const centered=resizeInBasis(basis,box,{x:120,y:40},{x:140,y:70},5,false,true,false)
  expect(apply(centered,{x:60,y:40})).toEqual({x:60,y:40})
  expect(apply(centered,{x:0,y:0}).x).toBeCloseTo(-20,9)
  expect(apply(centered,{x:0,y:0}).y).toBe(0)
})

test('group selection and property rotation use live child geometry in its local axes',()=>{
  const d=blank(),g=node('group',40,80,1,1),a=node('rectangle',30,20,120,60)
  g.children=[a.id];g.transform=multiply(g.transform,rotate(37));d.nodes={[g.id]:g,[a.id]:a};d.pages[0].children=[g.id]
  const b=selectionLocalBounds(d,g.id);expect(b).toEqual({x:30,y:20,width:120,height:60})
  const scaleFrame=selectionScaleFrame(d,d.pages[0].id,[g.id])
  expect(scaleFrame.width).toBeCloseTo(120,10);expect(scaleFrame.height).toBeCloseTo(60,10)
  expect(scaleAnchor(scaleFrame,0)).toEqual(apply(g.transform,{x:30,y:20}))
  const center=apply(g.transform,{x:90,y:50})
  rotateNode(g,-73,b)
  const next=apply(g.transform,{x:90,y:50});expect(next.x).toBeCloseTo(center.x,10);expect(next.y).toBeCloseTo(center.y,10)
  a.transform[4]+=25;expect(selectionLocalBounds(d,g.id).x).toBe(55)
})
