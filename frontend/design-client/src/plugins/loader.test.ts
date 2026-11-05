import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { bundleFromFiles } from './host'
import { loadPluginFromZipBytes, parseGitHubUrl } from './loader'
import manifestRaw from './__fixtures__/hello-world/manifest.json?raw'
import codeRaw from './__fixtures__/hello-world/code.js?raw'
import uiRaw from './__fixtures__/hello-world/ui.html?raw'

function fixtureFiles(): Record<string, string> {
  return { 'manifest.json': manifestRaw, 'code.js': codeRaw, 'ui.html': uiRaw }
}

describe('bundleFromFiles', () => {
  it('从文件映射组装插件包', () => {
    const bundle = bundleFromFiles(fixtureFiles(), 'unit')
    expect(bundle.manifest.name).toBe('Hello Futureox')
    expect(bundle.mainCode).toBe(codeRaw)
    expect(bundle.uiHtml).toBe(uiRaw)
  })
  it('manifest 可位于唯一子目录', () => {
    const files: Record<string, string> = {}
    for (const [path, content] of Object.entries(fixtureFiles())) files[`plugin-root/${path}`] = content
    expect(bundleFromFiles(files, 'unit').manifest.name).toBe('Hello Futureox')
  })
  it('缺少 manifest 或 main 时报错', () => {
    expect(() => bundleFromFiles({ 'code.js': codeRaw }, 'unit')).toThrow(/manifest\.json/)
    expect(() => bundleFromFiles({ 'manifest.json': manifestRaw }, 'unit')).toThrow(/main/)
  })
})

describe('loadPluginFromZipBytes', () => {
  it('解压根目录插件并读取文本文件', () => {
    const zip = zipSync({
      'manifest.json': strToU8(manifestRaw),
      'code.js': strToU8(codeRaw),
      'ui.html': strToU8(uiRaw),
      '__MACOSX/junk': strToU8('x'),
    })
    const bundle = loadPluginFromZipBytes(zip, 'zip-test')
    expect(bundle.manifest.main).toBe('code.js')
    expect(bundle.mainCode).toContain('figma.showUI')
  })
  it('GitHub zipball 形态：剥单根前缀后按子目录过滤', () => {
    const zip = zipSync({
      'plugin-samples-abc123/post-message/manifest.json': strToU8(manifestRaw),
      'plugin-samples-abc123/post-message/code.js': strToU8(codeRaw),
      'plugin-samples-abc123/post-message/ui.html': strToU8(uiRaw),
      'plugin-samples-abc123/other/manifest.json': strToU8('{}'),
    })
    expect(loadPluginFromZipBytes(zip, 'gh', 'post-message').manifest.name).toBe('Hello Futureox')
    expect(() => loadPluginFromZipBytes(zip, 'gh', 'missing-dir')).toThrow(/不存在目录/)
  })
  it('拒绝非 zip 字节', () => {
    expect(() => loadPluginFromZipBytes(new Uint8Array([1, 2, 3]), 'x')).toThrow(/zip/)
  })
})

describe('parseGitHubUrl', () => {
  it('解析 owner/repo、tree 引用与子目录', () => {
    expect(parseGitHubUrl('figma/plugin-samples')).toEqual({ owner: 'figma', repo: 'plugin-samples' })
    expect(parseGitHubUrl('https://github.com/figma/plugin-samples')).toEqual({ owner: 'figma', repo: 'plugin-samples' })
    expect(parseGitHubUrl('https://github.com/figma/plugin-samples/tree/main/hello-world')).toEqual({
      owner: 'figma', repo: 'plugin-samples', ref: 'main', subdir: 'hello-world',
    })
  })
  it('拒绝非法地址', () => {
    expect(() => parseGitHubUrl('')).toThrow()
    expect(() => parseGitHubUrl('https://gitlab.com/a/b')).toThrow()
  })
})
