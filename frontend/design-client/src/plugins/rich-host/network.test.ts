import { describe, expect, it } from 'vitest'
import { matchNetworkAccess } from './network'

const allowed = ['https://api.example.test', '*.cdn.test', 'http://localhost:3000']

describe('plugin network access', () => {
  it('allows declared https origins, wildcard subdomains, and explicit localhost', () => {
    expect(matchNetworkAccess('https://api.example.test/icons?q=1', allowed).ok).toBe(true)
    expect(matchNetworkAccess('https://images.cdn.test/a.png', allowed).ok).toBe(true)
    expect(matchNetworkAccess('http://localhost:3000/dev', allowed).ok).toBe(true)
  })

  it('refuses other hosts, the wildcard apex, private addresses, metadata, and credential URLs', () => {
    for (const url of [
      'https://evil.test/x',
      'https://cdn.test/apex',
      'http://api.example.test/insecure',
      'http://10.1.1.1/',
      'http://169.254.169.254/latest',
      'https://user:pass@api.example.test/',
      'file:///etc/passwd',
      'https://metadata.google.internal/',
    ]) expect(matchNetworkAccess(url, allowed).ok, url).toBe(false)
    expect(matchNetworkAccess('https://api.example.test/', ['none']).ok).toBe(false)
  })
})
