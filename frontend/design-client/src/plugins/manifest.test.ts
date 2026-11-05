import { describe, expect, it } from 'vitest'
import { parsePluginManifest, PluginManifestError } from './manifest'

const baseV2 = {
  name: 'Demo Plugin', id: 'com.example.demo', api: '1.0.0', main: 'code.js', ui: 'ui.html',
  editorType: ['figma'], documentAccess: 'dynamic-page',
  networkAccess: { allowedDomains: ['https://example.com'] }, manifestVersion: 2,
}

describe('parsePluginManifest', () => {
  it('解析完整的 manifestVersion 2', () => {
    const manifest = parsePluginManifest(baseV2)
    expect(manifest.manifestVersion).toBe(2)
    expect(manifest.main).toBe('code.js')
    expect(manifest.ui).toBe('ui.html')
    expect(manifest.editorType).toEqual(['figma'])
    expect(manifest.networkAccess?.allowedDomains).toEqual(['https://example.com'])
  })
  it('解析 manifestVersion 1（无 editorType/networkAccess，ui 可为对象）', () => {
    const manifest = parsePluginManifest({
      name: 'Legacy', api: '1.0.0', main: 'dist/code.js', ui: { src: 'ui.html', position: { x: 0, y: 0 } },
      manifestVersion: 1,
    })
    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.editorType).toEqual(['figma'])
    expect(manifest.ui).toBe('ui.html')
    expect(manifest.networkAccess).toBeUndefined()
  })
  it('manifestVersion 缺省按 v1 解析（存量社区插件形态）', () => {
    const manifest = parsePluginManifest({
      id: 'post-message', name: 'Post Message', api: '1.0.0', main: 'code.js', ui: 'ui.html',
      editorType: ['figma', 'figjam'], documentAccess: 'dynamic-page',
      networkAccess: { allowedDomains: ['none'] },
    })
    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.main).toBe('code.js')
  })
  it('拒绝未知 manifestVersion、缺失 main、目录穿越与非法 editorType', () => {
    expect(() => parsePluginManifest({ ...baseV2, manifestVersion: 3 })).toThrow(PluginManifestError)
    expect(() => parsePluginManifest({ ...baseV2, main: undefined })).toThrow(PluginManifestError)
    expect(() => parsePluginManifest({ ...baseV2, main: '../outside.js' })).toThrow(PluginManifestError)
    expect(() => parsePluginManifest({ ...baseV2, main: 'https://evil.example/code.js' })).toThrow(PluginManifestError)
    expect(() => parsePluginManifest({ ...baseV2, editorType: ['figjam'] })).toThrow(PluginManifestError)
    expect(() => parsePluginManifest({ ...baseV2, networkAccess: { allowedDomains: [42] } })).toThrow(PluginManifestError)
  })
  it('允许 figma+figjam 混合 editorType（含 figma 即可承载）', () => {
    expect(parsePluginManifest({ ...baseV2, editorType: ['figma', 'figjam'] }).editorType).toEqual(['figma', 'figjam'])
  })
})
