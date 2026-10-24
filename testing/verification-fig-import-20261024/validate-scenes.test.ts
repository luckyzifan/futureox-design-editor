import {test,expect} from '../../frontend/design-client/node_modules/vitest/dist/index.js'
import {readFileSync,writeFileSync} from 'node:fs'
import {validateDocument} from '../../frontend/design-client/src/model'
test('full admission of real dense Sketch scenes retains all coordinates',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../verification-render-smooth-color-20261024/source-fixtures.json',import.meta.url),'utf8'))
 const timings=[]
 for(const row of fixtures.records){const doc=JSON.parse(readFileSync(row.file,'utf8'));let start=performance.now();expect(validateDocument(doc)).toBe(doc);const cold=performance.now()-start;start=performance.now();validateDocument(doc);const warm=performance.now()-start;timings.push({key:row.key,coldMs:cold,warmMs:warm})}
 writeFileSync(new URL('./validation-timings.json',import.meta.url),JSON.stringify(timings,null,2))
})
