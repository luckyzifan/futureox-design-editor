// WebGPU 并行前缀和计算 - 用于描边计算管线
// Figma GpuStrokeBatcher 关键组件：countsPrefixSum

export const parallelPrefixSumWGSL = /* wgsl */`
// Blelloch 扫描算法（Work-Efficient）
// 时间复杂度：O(n)，工作复杂度：O(n)

@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> params: PrefixSumParams;

struct PrefixSumParams {
  count: u32,
  stride: u32,
  phase: u32,  // 0=up-sweep, 1=down-sweep
}

var<workgroup> sharedData: array<u32, 512>;

@compute @workgroup_size(256)
fn prefixSum(@builtin(local_invocation_id) local_id: vec3<u32>,
             @builtin(global_invocation_id) global_id: vec3<u32>,
             @builtin(workgroup_id) group_id: vec3<u32>) {
  let tid = local_id.x;
  let gid = global_id.x;

  // Load input into shared memory
  if (gid < params.count) {
    sharedData[tid] = input[gid];
  } else {
    sharedData[tid] = 0u;
  }
  if (tid + 256u < 512u && gid + 256u < params.count) {
    sharedData[tid + 256u] = input[gid + 256u];
  }
  workgroupBarrier();

  // Up-sweep phase (build sum tree)
  if (params.phase == 0u) {
    var stride = 1u;
    for (var d = 0u; d < 9u; d++) {  // log2(512) = 9
      if (tid < (256u >> d)) {
        let ai = stride * (2u * tid + 1u) - 1u;
        let bi = stride * (2u * tid + 2u) - 1u;
        if (bi < 512u) {
          sharedData[bi] += sharedData[ai];
        }
      }
      stride *= 2u;
      workgroupBarrier();
    }

    // Clear last element (exclusive scan)
    if (tid == 0u) {
      sharedData[511u] = 0u;
    }
    workgroupBarrier();
  }

  // Down-sweep phase (traverse down tree)
  if (params.phase == 1u) {
    var stride = 256u;
    for (var d = 0u; d < 9u; d++) {
      stride /= 2u;
      if (tid < (1u << (d + 1u))) {
        let ai = stride * (2u * tid + 1u) - 1u;
        let bi = stride * (2u * tid + 2u) - 1u;
        if (bi < 512u) {
          let t = sharedData[ai];
          sharedData[ai] = sharedData[bi];
          sharedData[bi] += t;
        }
      }
      workgroupBarrier();
    }
  }

  // Write output
  if (gid < params.count) {
    output[gid] = sharedData[tid];
  }
  if (tid + 256u < 512u && gid + 256u < params.count) {
    output[gid + 256u] = sharedData[tid + 256u];
  }
}

// Single-pass inclusive scan (simpler, for smaller arrays)
@compute @workgroup_size(256)
fn inclusiveScan(@builtin(local_invocation_id) local_id: vec3<u32>,
                 @builtin(global_invocation_id) global_id: vec3<u32>) {
  let tid = local_id.x;
  let gid = global_id.x;

  if (gid < params.count) {
    sharedData[tid] = input[gid];
  } else {
    sharedData[tid] = 0u;
  }
  workgroupBarrier();

  // Kogge-Stone scan (parallel, but not work-efficient)
  for (var d = 1u; d < 256u; d *= 2u) {
    var val = 0u;
    if (tid >= d) {
      val = sharedData[tid - d];
    }
    workgroupBarrier();
    if (tid >= d) {
      sharedData[tid] += val;
    }
    workgroupBarrier();
  }

  if (gid < params.count) {
    output[gid] = sharedData[tid];
  }
}
`
