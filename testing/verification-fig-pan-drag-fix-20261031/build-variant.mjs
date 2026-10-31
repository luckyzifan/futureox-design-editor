import {build} from '../../frontend/design-client/node_modules/vite/dist/node/index.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),[out,flag,value]=process.argv.slice(2)
if(!out||!path.isAbsolute(out)||!['VITE_DESIGN_RASTER_BACKPRESSURE','VITE_DESIGN_LOCAL_PREPARE_SCOPE'].includes(flag)||!['0','1'].includes(value))throw Error('Fresh absolute output and known isolated control required')
await fs.mkdir(out)
const sources=await buildInputs(root)
await build({root:path.join(root,'frontend/design-client'),configFile:path.join(root,'frontend/design-client/vite.config.ts'),base:'./',define:{['import.meta.env.'+flag]:JSON.stringify(value)},build:{outDir:path.join(out,'renderer'),emptyOutDir:false}})
for(const directory of ['sidecar','bin','fonts'])await fs.symlink(path.join(root,'frontend/design-desktop/dist',directory),path.join(out,directory))
await fs.writeFile(path.join(out,'build-manifest.json'),JSON.stringify({format:1,builtAt:new Date().toISOString(),platform:process.platform,arch:process.arch,profile:'desktop-dev',variant:flag+'='+value,sources},null,2))
