// Native source references contain only the editor session and an asset key.
// The desktop protocol checks the active owner before serving any pixels.
const reference=/^design-app:\/\/app\/source-image\/([a-zA-Z0-9-]{1,160})\/([a-f0-9]{64})-([1-9]\d{0,8})x([1-9]\d{0,8})\.png(\?samples=1)?$/
export function sourceBitmap(uri: unknown) {
  if(typeof uri!=='string'||!uri.startsWith('design-app://app/source-image/'))return
  const m=reference.exec(uri);if(m)return {width:Number(m[3]),height:Number(m[4]),samples:!!m[5]}
}
