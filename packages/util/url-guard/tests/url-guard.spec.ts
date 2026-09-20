import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, assertPublicWebSocketUrl, isPublicHost } from '../src/index.ts'

describe('isPublicHost', () => {
  it('accepts ordinary domain names', () => {
    expect(isPublicHost('api.stepfun.com')).toBe(true)
    expect(isPublicHost('gateway.internal.example.com')).toBe(true)
  })

  it('rejects localhost and its subdomains', () => {
    expect(isPublicHost('localhost')).toBe(false)
    expect(isPublicHost('app.localhost')).toBe(false)
  })

  it('rejects loopback and private IPv4 literals', () => {
    expect(isPublicHost('127.0.0.1')).toBe(false)
    expect(isPublicHost('10.1.2.3')).toBe(false)
    expect(isPublicHost('172.16.0.1')).toBe(false)
    expect(isPublicHost('192.168.1.1')).toBe(false)
    expect(isPublicHost('0.0.0.0')).toBe(false)
  })

  it('rejects reserved IPv4 literals', () => {
    expect(isPublicHost('169.254.1.1')).toBe(false)
    expect(isPublicHost('224.0.0.1')).toBe(false)
    expect(isPublicHost('255.255.255.255')).toBe(false)
    expect(isPublicHost('192.0.2.10')).toBe(false)
  })

  it('accepts a public IPv4 literal', () => {
    expect(isPublicHost('8.8.8.8')).toBe(true)
  })

  it('rejects loopback, link-local, and unique-local IPv6 literals', () => {
    expect(isPublicHost('::1')).toBe(false)
    expect(isPublicHost('[::1]')).toBe(false)
    expect(isPublicHost('fe80::1')).toBe(false)
    expect(isPublicHost('fc00::1')).toBe(false)
    expect(isPublicHost('[fd12::1]')).toBe(false)
  })

  it('classifies IPv4-mapped IPv6 by its embedded address', () => {
    expect(isPublicHost('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicHost('::ffff:8.8.8.8')).toBe(true)
  })
})

describe('assertPublicHttpUrl', () => {
  it('accepts the public StepFun endpoint', () => {
    expect(assertPublicHttpUrl('https://api.stepfun.com/v1', 'test').href).toBe('https://api.stepfun.com/v1')
  })

  it('rejects a non-URL', () => {
    expect(() => assertPublicHttpUrl('not a url', 'test')).toThrow(/not a valid URL/)
  })

  it('rejects non-HTTP schemes', () => {
    expect(() => assertPublicHttpUrl('wss://api.stepfun.com', 'test')).toThrow(/http: or https:/)
    expect(() => assertPublicHttpUrl('file:///etc/passwd', 'test')).toThrow(/http: or https:/)
  })

  it('rejects embedded credentials, query, and fragment', () => {
    expect(() => assertPublicHttpUrl('https://user:pass@api.stepfun.com', 'test')).toThrow(/credentials/)
    expect(() => assertPublicHttpUrl('https://api.stepfun.com/?x=1', 'test')).toThrow(/query or fragment/)
    expect(() => assertPublicHttpUrl('https://api.stepfun.com/#f', 'test')).toThrow(/query or fragment/)
  })

  it('rejects localhost and private hosts', () => {
    expect(() => assertPublicHttpUrl('http://localhost:8080', 'test')).toThrow(/loopback, private, or reserved/)
    expect(() => assertPublicHttpUrl('http://127.0.0.1:8080', 'test')).toThrow(/loopback, private, or reserved/)
    expect(() => assertPublicHttpUrl('http://10.0.0.5/', 'test')).toThrow(/loopback, private, or reserved/)
  })
})

describe('assertPublicWebSocketUrl', () => {
  it('accepts the public realtime endpoint', () => {
    expect(assertPublicWebSocketUrl('wss://api.stepfun.com/v1/realtime', 'test').href)
      .toBe('wss://api.stepfun.com/v1/realtime')
  })

  it('rejects HTTP schemes and private hosts alike', () => {
    expect(() => assertPublicWebSocketUrl('https://api.stepfun.com', 'test')).toThrow(/ws: or wss:/)
    expect(() => assertPublicWebSocketUrl('ws://localhost/', 'test')).toThrow(/loopback, private, or reserved/)
  })
})
