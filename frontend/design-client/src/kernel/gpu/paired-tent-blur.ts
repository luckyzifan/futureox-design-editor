/**
 * Figma 成对采样帐篷模糊(CPU 侧 uniform 计算)。
 *
 * 契约事实:
 * - CPU 只算两个 uniform:`count`(帐篷半径,tap 数)与 `blurDelta`(方向×间距);
 * - GPU 侧 ≤64 有界循环早退,权重解析给出(count-k),无核纹理;
 * - 相邻 tap 位置按权重插值 → 线性采样一次 fetch 精确等于两次 tap 的加权平均。
 *
 * `countForRadius` 的换算遵循帐篷核的方差匹配(σ² = count²/12 的离散帐篷),
 * 使交互档与 CPU 帐篷滤波的视觉半径一致;`blurDelta` = 方向单位向量 × 1/count,
 * 即相邻 tap 间距 = 1 纹素(成对采样的几何前提)。
 */
export function pairedTentBlurUniforms(
  radiusPx: number,
  horizontal: boolean,
  textureSize: { width: number; height: number },
): { count: number; blurDelta: [number, number]; quad: [number, number, number, number] } {
  if (!(radiusPx > 0) || !Number.isFinite(radiusPx)) {
    throw new Error('Invalid blur radius')
  }
  // 帐篷核 σ² = count²/12;高斯 σ² = r²/2 → count = r·√6,再夹到 64 上界
  const count = Math.min(64, Math.max(1, radiusPx * Math.sqrt(6)))
  const step = radiusPx / count / (horizontal ? textureSize.width : textureSize.height)
  const blurDelta: [number, number] = horizontal ? [step, 0] : [0, step]
  return {
    count,
    blurDelta,
    quad: [0, 0, 1, 1],
  }
}

/** 纯数学参照:成对采样帐篷在一维上的期望输出(测试用,与逐 tap 帐篷等价)。 */
export function pairedTentSample(
  taps: Float32Array,
  count: number,
  tapIndex: number,
): number {
  // 中心 + 两侧 [1, count] 的帐篷权重和(与 GPU 侧的 d 累加一致)
  let weightSum = count
  let value = taps[tapIndex] * count
  for (let k = 1; k <= Math.floor(count); k++) {
    const w = count - k
    const minus = taps[tapIndex - k] ?? 0
    const plus = taps[tapIndex + k] ?? 0
    value += w * (minus + plus)
    weightSum += 2 * w
  }
  return value / weightSum
}

/** Figma 的 RGBA8 标量打包阶梯(测试用参照):
 * pack 两级嵌套,unpack 是 1/255→1/65025→1/16581375 点积。 */
export function packScalarRgba8(b: number): [number, number, number, number] {
  const pack2 = (v: number): [number, number] => {
    const c = Math.floor(v * 255) / 255
    return [c, (v - c) * 255]
  }
  const f = pack2(b)
  const g = f[0] + f[1] / 255
  const i = pack2((b - g) * 65025)
  return [f[0], f[1], i[0], i[1]]
}
export function unpackScalarRgba8(v: [number, number, number, number]): number {
  return v[0] + v[1] / 255 + v[2] / 65025 + v[3] / 16581375
}
