/** Stroke expansion helpers and WebGPU compute program. */
/**
 * GPU 描边计算管线架构：
 *
 * 1. Euler Stroke Fill: 使用欧拉公式计算描边路径扩展
 *    - 输入：中心线路径 + 描边宽度
 *    - 输出：扩展后的外轮廓顶点
 *
 * 2. Prefix Sum: 前缀和算法分配顶点存储
 *    - 并行计算每段描边需要的顶点数
 *    - 前缀和得到每段的起始偏移
 *
 * 3. Stroke Offset Deltas: 计算偏移增量
 *    - 处理尖角、圆角、斜接等连接样式
 *    - 生成最终几何数据
 */

export interface StrokeStyle {
  width: number
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  miterLimit: number
  dashArray?: number[]
  dashOffset?: number
}

export interface StrokeSegment {
  p0: [number, number]  // 起点
  p1: [number, number]  // 终点
  normal: [number, number]  // 法线
}

/** 计算描边几何所需的 WebGPU compute shader 源码 */
export const strokeComputeShaderWGSL = `
// 描边扩展计算 - Compute Shader
struct StrokeParams {
  width: f32,
  miterLimit: f32,
  capStyle: u32,  // 0=butt, 1=round, 2=square
  joinStyle: u32, // 0=miter, 1=round, 2=bevel
  segmentCount: u32,
  padding: array<u32, 3>,
}

struct Segment {
  p0: vec2<f32>,
  p1: vec2<f32>,
  normal: vec2<f32>,
  padding: vec2<f32>,
}

struct VertexOutput {
  position: vec2<f32>,
  texCoord: vec2<f32>,
}

@group(0) @binding(0) var<uniform> params: StrokeParams;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<storage, read_write> vertexCounts: array<u32>;
@group(0) @binding(3) var<storage, read_write> vertexOffsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> vertices: array<VertexOutput>;

// 欧拉描边填充：计算单个线段的扩展顶点数
@compute @workgroup_size(256)
fn eulerStrokeFill(@builtin(global_invocation_id) id: vec3<u32>) {
  let segmentId = id.x;
  if (segmentId >= params.segmentCount) { return; }

  let segment = segments[segmentId];
  let halfWidth = params.width * 0.5;

  // 基础矩形需要 4 个顶点
  var count = 4u;

  // 圆角连接/端点需要额外的扇形顶点
  if (params.joinStyle == 1u) {  // round join
    // 粗略估计：每个圆角 8 个顶点（实际根据角度动态调整）
    count += 8u;
  }
  if (params.capStyle == 1u) {  // round cap
    count += 8u;
  }

  vertexCounts[segmentId] = count;
}

// 前缀和计算：并行分配顶点偏移
// 使用 work-efficient parallel scan 算法
@compute @workgroup_size(256)
fn countsPrefixSum(@builtin(global_invocation_id) id: vec3<u32>) {
  let idx = id.x;
  let valid = idx < params.segmentCount;

  // Up-sweep phase (reduction)
  var offset = 1u;
  for (var d = params.segmentCount >> 1u; d > 0u; d >>= 1u) {
    if (valid && idx < d) {
      let ai = offset * (2u * idx + 1u) - 1u;
      let bi = offset * (2u * idx + 2u) - 1u;
      vertexCounts[bi] += vertexCounts[ai];
    }
    offset <<= 1u;
    workgroupBarrier();
  }

  // Clear last element
  if (valid && idx == 0u) {
    vertexCounts[params.segmentCount - 1u] = 0u;
  }
  workgroupBarrier();

  // Down-sweep phase
  for (var d = 1u; d < params.segmentCount; d <<= 1u) {
    offset >>= 1u;
    if (valid && idx < d) {
      let ai = offset * (2u * idx + 1u) - 1u;
      let bi = offset * (2u * idx + 2u) - 1u;
      let t = vertexCounts[ai];
      vertexCounts[ai] = vertexCounts[bi];
      vertexCounts[bi] += t;
    }
    workgroupBarrier();
  }

  // Write to offsets
  if (valid) {
    vertexOffsets[idx] = vertexCounts[idx];
  }
}

// 生成描边几何：根据偏移生成最终顶点
@compute @workgroup_size(256)
fn strokeOffsetDeltas(@builtin(global_invocation_id) id: vec3<u32>) {
  let segmentId = id.x;
  if (segmentId >= params.segmentCount) { return; }

  let segment = segments[segmentId];
  let halfWidth = params.width * 0.5;
  let offset = vertexOffsets[segmentId];

  // 计算垂直方向的偏移向量
  let perpendicular = vec2<f32>(-segment.normal.y, segment.normal.x);
  let offset0 = perpendicular * halfWidth;
  let offset1 = -offset0;

  // 生成矩形的四个顶点
  vertices[offset + 0u] = VertexOutput(segment.p0 + offset0, vec2<f32>(0.0, 0.0));
  vertices[offset + 1u] = VertexOutput(segment.p0 + offset1, vec2<f32>(0.0, 1.0));
  vertices[offset + 2u] = VertexOutput(segment.p1 + offset0, vec2<f32>(1.0, 0.0));
  vertices[offset + 3u] = VertexOutput(segment.p1 + offset1, vec2<f32>(1.0, 1.0));

  // 处理圆角连接和端点
  if (params.joinStyle == 1u || params.capStyle == 1u) {
    // 圆角需要扇形三角形，根据描边宽度动态计算段数
    // 粗略公式：circleSegments = max(4, ceil(halfWidth * 0.5))
    let circleSegments = u32(max(4.0, ceil(halfWidth * 0.5)));
    let angleStep = 3.14159265359 / f32(circleSegments);

    var currentOffset = 4u;

    // 如果是圆角连接，在线段连接处生成扇形
    if (params.joinStyle == 1u && segmentId + 1u < params.segmentCount) {
      let nextSegment = segments[segmentId + 1u];
      // 计算两段之间的角度
      let dir1 = normalize(segment.p1 - segment.p0);
      let dir2 = normalize(nextSegment.p1 - nextSegment.p0);
      let angle = acos(clamp(dot(dir1, dir2), -1.0, 1.0));

      // 生成扇形顶点
      for (var i = 0u; i < circleSegments; i++) {
        let t = f32(i) / f32(circleSegments - 1u);
        let currentAngle = t * angle;
        let rotatedOffset = vec2<f32>(
          offset0.x * cos(currentAngle) - offset0.y * sin(currentAngle),
          offset0.x * sin(currentAngle) + offset0.y * cos(currentAngle)
        );
        vertices[offset + currentOffset] = VertexOutput(
          segment.p1 + rotatedOffset,
          vec2<f32>(0.5, 0.5 + t * 0.5)
        );
        currentOffset++;
      }
    }

    // 圆角端点（起点）
    if (params.capStyle == 1u && segmentId == 0u) {
      for (var i = 0u; i < circleSegments; i++) {
        let t = f32(i) / f32(circleSegments - 1u);
        let angle = 3.14159265359 * (0.5 + t * 0.5);
        let capOffset = vec2<f32>(cos(angle), sin(angle)) * halfWidth;
        vertices[offset + currentOffset] = VertexOutput(
          segment.p0 + capOffset,
          vec2<f32>(0.0, 0.5 + t * 0.5)
        );
        currentOffset++;
      }
    }

    // 圆角端点（终点）
    if (params.capStyle == 1u && segmentId + 1u == params.segmentCount) {
      for (var i = 0u; i < circleSegments; i++) {
        let t = f32(i) / f32(circleSegments - 1u);
        let angle = 3.14159265359 * (1.5 + t * 0.5);
        let capOffset = vec2<f32>(cos(angle), sin(angle)) * halfWidth;
        vertices[offset + currentOffset] = VertexOutput(
          segment.p1 + capOffset,
          vec2<f32>(1.0, 0.5 + t * 0.5)
        );
        currentOffset++;
      }
    }
  }
}
`

/** GPU 描边计算器 */
export class GpuStrokeBatcher {
  private device: GPUDevice
  private pipeline?: GPUComputePipeline
  private prefixSumPipeline?: GPUComputePipeline
  private offsetPipeline?: GPUComputePipeline

  constructor(device: GPUDevice) {
    this.device = device
  }

  async initialize() {
    const module = this.device.createShaderModule({
      code: strokeComputeShaderWGSL,
      label: 'Stroke compute shader',
    })

    // 创建三个计算管线
    this.pipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'eulerStrokeFill' },
    })

    this.prefixSumPipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'countsPrefixSum' },
    })

    this.offsetPipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'strokeOffsetDeltas' },
    })
  }

  /**
   * 在 GPU 上计算描边几何
   * @returns 扩展后的顶点数组
   */
  async computeStroke(
    segments: StrokeSegment[],
    style: StrokeStyle,
  ): Promise<Float32Array> {
    if (!this.pipeline || !this.prefixSumPipeline || !this.offsetPipeline) {
      throw new Error('GPU stroke batcher not initialized')
    }

    // 准备输入数据
    const segmentData = new Float32Array(segments.length * 8)  // 每段 8 个 float
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const offset = i * 8
      segmentData[offset + 0] = seg.p0[0]
      segmentData[offset + 1] = seg.p0[1]
      segmentData[offset + 2] = seg.p1[0]
      segmentData[offset + 3] = seg.p1[1]
      segmentData[offset + 4] = seg.normal[0]
      segmentData[offset + 5] = seg.normal[1]
      segmentData[offset + 6] = 0  // padding
      segmentData[offset + 7] = 0
    }

    // 创建 GPU buffers
    const segmentBuffer = this.device.createBuffer({
      size: segmentData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(segmentBuffer, 0, segmentData)

    const countBuffer = this.device.createBuffer({
      size: segments.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })

    const offsetBuffer = this.device.createBuffer({
      size: segments.length * 4,
      usage: GPUBufferUsage.STORAGE,
    })

    // 预估最大顶点数（实际会更少，但需要足够的空间）
    const maxVertices = segments.length * 20  // 每段最多 20 个顶点
    const vertexBuffer = this.device.createBuffer({
      size: maxVertices * 16,  // 每个顶点 4 个 float (pos + texCoord)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })

    // 创建 uniform buffer
    const paramsData = new Uint32Array(8)
    paramsData[0] = style.width
    paramsData[1] = style.miterLimit
    paramsData[2] = style.cap === 'round' ? 1 : style.cap === 'square' ? 2 : 0
    paramsData[3] = style.join === 'round' ? 1 : style.join === 'bevel' ? 2 : 0
    paramsData[4] = segments.length

    const paramsBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(paramsBuffer, 0, paramsData)

    // 执行三个计算阶段
    const encoder = this.device.createCommandEncoder()

    // Stage 1: 计算顶点数
    const pass1 = encoder.beginComputePass()
    pass1.setPipeline(this.pipeline)
    // TODO: 创建 bind group 并绑定
    pass1.dispatchWorkgroups(Math.ceil(segments.length / 256))
    pass1.end()

    // Stage 2: 前缀和
    const pass2 = encoder.beginComputePass()
    pass2.setPipeline(this.prefixSumPipeline!)
    // TODO: 创建 bind group 并绑定
    pass2.dispatchWorkgroups(Math.ceil(segments.length / 256))
    pass2.end()

    // Stage 3: 生成顶点
    const pass3 = encoder.beginComputePass()
    pass3.setPipeline(this.offsetPipeline!)
    // TODO: 创建 bind group 并绑定
    pass3.dispatchWorkgroups(Math.ceil(segments.length / 256))
    pass3.end()

    // 读回结果
    const readBuffer = this.device.createBuffer({
      size: maxVertices * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    encoder.copyBufferToBuffer(vertexBuffer, 0, readBuffer, 0, maxVertices * 16)

    this.device.queue.submit([encoder.finish()])

    await readBuffer.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(readBuffer.getMappedRange()).slice()
    readBuffer.unmap()

    // 清理
    segmentBuffer.destroy()
    countBuffer.destroy()
    offsetBuffer.destroy()
    vertexBuffer.destroy()
    paramsBuffer.destroy()
    readBuffer.destroy()

    return result
  }
}
