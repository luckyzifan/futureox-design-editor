/** Keep the exact bundled font contract, but overlap its transfer with WASM
 * compilation. A failure of either dependency rejects the authoritative boot. */
export async function loadKernelResources(initialize: () => Promise<unknown>, fetchFont: typeof fetch = fetch) {
  const [, font] = await Promise.all([
    initialize(),
    (async () => {
      const response = await fetchFont('/fonts/NotoSansSC.ttf')
      if (!response.ok) throw Error('无法载入矢量字形字体')
      return new Uint8Array(await response.arrayBuffer())
    })(),
  ])
  return font
}
