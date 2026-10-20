/** Independent Fraction expectations against the current production WGSL helper. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  command,
  project,
  repository,
  runProof,
  shaderRoot,
  sha256,
} from './exact-prefix-proof-utils'
import { wideGpuVectors } from './exact-prefix-division-vectors'
const generator = join(repository, 'design-studio/scripts/generate-prefix-vectors.py')
const oracle = join(repository, 'design-studio/scripts/generate-precision-vectors.py')
await runProof('forma-prefix-math', [generator, oracle, join(project,'scripts/exact-prefix-division-vectors.ts')], async (proof) => {
  const vectors = join(proof.output, 'vectors')
  await command('python3', [generator, '--output', vectors])
  const fixture = JSON.parse(await readFile(join(vectors, 'helper-vectors.json'), 'utf8'))
  const wide = wideGpuVectors()
  await proof.write('wide-division-vectors.json',wide)
  fixture.rows.push(...wide.rows)
  fixture.counts={...fixture.counts,...wide.counts}
  const helper = await readFile(join(project, 'src/kernel/gpu/prefix-int128.wgsl'), 'utf8')
  const sampling = await readFile(join(shaderRoot, 'sampling.wgsl'), 'utf8')
  if (!sampling.includes('fn bsParts') || !helper.includes('fn prefix_round_ratio'))
    throw Error('Production helper structure changed')
  const code =
    sampling.slice(0, sampling.indexOf('fn bsParts')) +
    helper +
    `
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<vec4<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}
 let at=id.x*16u;let op=inputs[at];let a=vec4<u32>(inputs[at+1u],inputs[at+2u],inputs[at+3u],inputs[at+4u]);
 let b=vec4<u32>(inputs[at+5u],inputs[at+6u],inputs[at+7u],inputs[at+8u]);var result=vec4<u32>(0u);
 switch op{
 case 0u:{let value=prefix_round_ratio(a,b.x,bitcast<i32>(b.y));result=vec4<u32>(value,0u,0u);}
 case 1u:{result=prefix_add(a,b);}
 case 2u:{result=prefix_sub(a,b);}
 case 3u:{result=prefix_mul_i32(a,bitcast<i32>(b.x));}
 case 4u:{result=prefix_shl(a,b.x);}
 case 5u:{result=prefix_sample(a.x,b.x);}
 case 6u:{let value=prefix_round_wide(a,b,bitcast<i32>(inputs[at+9u]));result=vec4<u32>(value,0u,0u);}
 case 7u:{let value=prefix_try_quotient(a,b,bitcast<f32>(inputs[at+9u]));result=vec4<u32>(value.quotient,value.accepted,0u,0u);}
 case 8u:{let value=prefix_try_quotient(a,b,bitcast<f32>(inputs[at+9u]));result=value.remainder;}
 default:{}
 }
 outputs[id.x]=result;
}`

  const prepared = {
    checks: fixture.rows.length,
    counts: fixture.counts,
    shaderSha256: sha256(code),
    expectedSource: 'Independent Python integers/Fraction plus BigInt rational division for wide/RNE and adversarial quotient estimates; no WGSL reducer in expectation generation',
  }
  if (proof.prepareOnly) return prepared
  const result = await proof.browser((page) =>
    page.evaluate(
      async ({ code, rows }) => {
        const adapter = await navigator.gpu?.requestAdapter()
        if (!adapter) throw new Error('Real WebGPU required')
        const device = await adapter.requestDevice()
        const errors: string[] = []
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message))
        try {
          const module = device.createShaderModule({ code })
          const compile = (await module.getCompilationInfo()).messages.filter(
            (m) => m.type === 'error',
          )
          if (compile.length)
            throw new Error(compile.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
          const pipeline = await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
          })
          const data = new Uint32Array(rows.flatMap((r: number[][]) => r[0]))
          const size = rows.length * 16
          const input = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          })
          device.queue.writeBuffer(input, 0, data)
          const output = device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          })
          const readback = device.createBuffer({
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          })
          const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: input } },
              { binding: 1, resource: { buffer: output } },
            ],
          })
          const encoder = device.createCommandEncoder()
          const pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(Math.ceil(rows.length / 64))
          pass.end()
          encoder.copyBufferToBuffer(output, 0, readback, 0, size)
          device.queue.submit([encoder.finish()])
          await readback.mapAsync(GPUMapMode.READ)
          const actual = new Uint32Array(readback.getMappedRange())
          let failures = 0
          const examples = []
          for (let i = 0; i < rows.length; i++) {
            const want = rows[i][1]
            if (want.some((v: number, j: number) => v !== actual[i * 4 + j])) {
              failures++
              if (examples.length < 16)
                examples.push({
                  index: i,
                  input: rows[i][0],
                  expected: want,
                  actual: Array.from(actual.subarray(i * 4, i * 4 + 4)),
                })
            }
          }
          readback.unmap()
          if (errors.length) throw new Error(errors.join('\n'))
          return {
            adapter: {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              description: adapter.info.description,
            },
            checks: rows.length,
            components: rows.length * 4,
            failures,
            examples,
          }
        } finally {
          device.destroy()
        }
      },
      { code, rows: fixture.rows },
    ),
  )
  await proof.write('gpu-result.json', result)
  if (result.failures)
    throw Error(`${result.failures} helper rows differ from Fraction expectations`)
  return { ...prepared, ...result }
})
