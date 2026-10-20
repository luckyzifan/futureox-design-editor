/** Closed, typed prototype expressions. No source code, coercion, I/O or recursion references. */
import type { DesignDocument } from './model'
import type { PrototypeAction } from './prototype'
export type Scalar = string | number | boolean
export type Expr = {kind:'literal';value:Scalar} | {kind:'variable';id:string} | {kind:'unary';op:'not'|'negate';arg:Expr} | {kind:'binary';op:'eq'|'ne'|'lt'|'lte'|'gt'|'gte'|'and'|'or'|'add'|'subtract'|'multiply'|'divide'|'concat';left:Expr;right:Expr}
export const LOGIC_LIMITS = {depth:16,nodes:256,steps:512,number:1e12,stringBytes:4096} as const
export function scalar(value:unknown):Scalar {
  if(typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=LOGIC_LIMITS.number)return value
  if(typeof value==='string'&&new TextEncoder().encode(value).length<=LOGIC_LIMITS.stringBytes)return value
  throw new Error('Prototype scalar exceeds finite number/string limits')
}
export type LogicBudget = {steps:number}
export function tick(budget:LogicBudget){if(++budget.steps>LOGIC_LIMITS.steps)throw new Error('Prototype execution step budget exceeded')}
export function expressionType(expr:Expr,doc:DesignDocument,budget={nodes:0},depth=0,seen=new Set<object>()):string {
  if(!expr||typeof expr!=='object'||seen.has(expr)||depth>LOGIC_LIMITS.depth||++budget.nodes>LOGIC_LIMITS.nodes)throw new Error('Prototype expression cycle/depth/node budget')
  seen.add(expr)
  const fields:Record<string,string[]>={literal:['kind','value'],variable:['kind','id'],unary:['kind','op','arg'],binary:['kind','op','left','right']}
  if(!fields[expr.kind]||Object.keys(expr).some(k=>!fields[expr.kind].includes(k)))throw new Error('Unknown prototype expression field')
  const child=(e:Expr)=>expressionType(e,doc,budget,depth+1,seen)
  let result:string
  if(expr.kind==='literal')result=typeof scalar(expr.value)
  else if(expr.kind==='variable'){
    const variable=doc.designSystem?.variables[expr.id]
    if(!variable||!['number','string','boolean'].includes(variable.kind))throw new Error('Prototype expression variable missing or unsupported')
    result=variable.kind
  }else if(expr.kind==='unary'){
    const type=child(expr.arg),wanted=expr.op==='not'?'boolean':expr.op==='negate'?'number':''
    if(type!==wanted)throw new Error('Prototype unary type mismatch')
    result=wanted
  }else{
    const left=child(expr.left),right=child(expr.right)
    const wanted=['and','or'].includes(expr.op)?'boolean':expr.op==='concat'?'string':['add','subtract','multiply','divide','lt','lte','gt','gte'].includes(expr.op)?'number':undefined
    if(left!==right||(wanted&&left!==wanted)||(!wanted&&!['eq','ne'].includes(expr.op)))throw new Error('Prototype binary type mismatch')
    result=['eq','ne','lt','lte','gt','gte','and','or'].includes(expr.op)?'boolean':left
  }
  seen.delete(expr);return result
}
export function evaluate(expr:Expr,read:(id:string)=>Scalar,budget:LogicBudget):Scalar {
  tick(budget)
  if(expr.kind==='literal')return scalar(expr.value)
  if(expr.kind==='variable')return scalar(read(expr.id))
  if(expr.kind==='unary'){const value=evaluate(expr.arg,read,budget);if(typeof value!==(expr.op==='not'?'boolean':'number'))throw new Error('Prototype unary runtime type mismatch');return expr.op==='not'?!value:scalar(-(value as number))}
  const left=evaluate(expr.left,read,budget)
  const expected=['and','or'].includes(expr.op)?'boolean':expr.op==='concat'?'string':['eq','ne'].includes(expr.op)?typeof left:'number'
  if(typeof left!==expected)throw new Error('Prototype binary runtime type mismatch')
  if(expr.op==='and'&&left===false)return false
  if(expr.op==='or'&&left===true)return true
  const right=evaluate(expr.right,read,budget)
  if(typeof right!==expected)throw new Error('Prototype binary runtime type mismatch')
  switch(expr.op){
    case 'eq':return left===right;case 'ne':return left!==right
    case 'lt':return left<right;case 'lte':return left<=right;case 'gt':return left>right;case 'gte':return left>=right
    case 'and':return left===true&&right===true;case 'or':return left===true||right===true
    case 'concat':return scalar((left as string)+(right as string))
    case 'add':return scalar((left as number)+(right as number));case 'subtract':return scalar((left as number)-(right as number));case 'multiply':return scalar((left as number)*(right as number))
    case 'divide':if(right===0)throw new Error('Prototype division by zero');return scalar((left as number)/(right as number))
  }
}
export function validateLogicActions(doc:DesignDocument,actions:PrototypeAction[],budget={nodes:0},depth=0,seen=new Set<object>()) {
  if(!Array.isArray(actions)||actions.length>32||depth>LOGIC_LIMITS.depth||seen.has(actions))throw new Error('Prototype action depth/cycle/list budget')
  seen.add(actions)
  for(const a of actions){
    if(!a||typeof a!=='object'||++budget.nodes>LOGIC_LIMITS.nodes)throw new Error('Prototype action node budget')
    if(a.kind==='if'){
      if(!a.expression||expressionType(a.expression,doc,budget)!=='boolean'||!Array.isArray(a.thenActions)||!Array.isArray(a.elseActions))throw new Error('Prototype if requires boolean expression and branches')
      validateLogicActions(doc,a.thenActions,budget,depth+1,seen);validateLogicActions(doc,a.elseActions,budget,depth+1,seen)
    }else{
      if(a.thenActions!==undefined||a.elseActions!==undefined)throw new Error('Branches require if action')
      if(a.expression){
        if(a.kind!=='set-variable'||a.value!==undefined)throw new Error('Expression requires assignment without literal value')
        const target=a.targetVariable||a.targetVariableData?.id||a.target||''
        if(expressionType(a.expression,doc,budget)!==doc.designSystem?.variables[target]?.kind)throw new Error('Prototype assignment expression type mismatch')
      }
    }
  }
  seen.delete(actions)
}
export const hasLogic = (actions:PrototypeAction[]):boolean => actions.some(a=>a.kind==='if'||a.expression!==undefined)
/** Visitors also keep clipboard, variable deletion and graph edits lossless. */
export function allActions(actions:PrototypeAction[]):PrototypeAction[]{return actions.flatMap(a=>[a,...allActions(a.thenActions||[]),...allActions(a.elseActions||[])])}
export function expressionVariables(expr?:Expr):Extract<Expr,{kind:'variable'}>[]{if(!expr)return [];return expr.kind==='variable'?[expr]:expr.kind==='unary'?expressionVariables(expr.arg):expr.kind==='binary'?[...expressionVariables(expr.left),...expressionVariables(expr.right)]:[]}
