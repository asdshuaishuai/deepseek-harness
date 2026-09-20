/**
 * Public-endpoint URL validation for server-side requests. The guard runs
 * before any request is issued: only HTTP(S) — or WS(S) for the realtime
 * upgrade — is accepted, URLs carry no credentials, query, or fragment, and
 * the host is checked against localhost, loopback, private, and reserved
 * addresses. Non-literal hostnames pass the host check (they are operator
 * configuration, not model-chosen URLs); callers that connect on behalf of
 * untrusted input resolve first and re-check every answer with
 * {@link isPublicHost}.
 *
 * @module @deepseek-ai/dsh-url-guard
 */

import ipaddr from 'ipaddr.js'

/** Schemes accepted for plain HTTP requests. */
const HTTP_SCHEMES = new Set(['http:', 'https:'])

/** Schemes accepted for WebSocket upgrade requests. */
const WEB_SOCKET_SCHEMES = new Set(['ws:', 'wss:'])

/**
 * Whether a URL hostname names a host a server-side request may be sent to.
 * `localhost` (and its subdomains) and any IP literal that is loopback,
 * private, link-local, multicast, or otherwise reserved are refused; public
 * unicast literals and ordinary domain names pass.
 * @param hostname - URL hostname, bracketed or not when it is an IPv6 literal.
 * @returns true when the host is not localhost and not a non-public IP literal.
 */
export function isPublicHost(hostname: string): boolean {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (unbracketed === '' || unbracketed === 'localhost' || unbracketed.endsWith('.localhost')) return false
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(unbracketed)
  } catch {
    // Not an IP literal: an ordinary name, judged by resolution at connect time.
    return true
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * Parse and validate one request URL against the public-endpoint policy.
 * @param value - the URL as configured.
 * @param schemes - the accepted scheme set (`http:`/`https:` or `ws:`/`wss:`).
 * @param owner - prefix naming the validating component, for the thrown message.
 * @returns the parsed URL.
 * @throws `Error` when the value is not a URL, uses another scheme, carries
 *   credentials, a query, or a fragment, or its host is not public.
 */
function assertUrl(value: string, schemes: ReadonlySet<string>, owner: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${owner}: "${value}" is not a valid URL`)
  }
  if (!schemes.has(parsed.protocol)) {
    throw new Error(`${owner}: "${value}" must use ${[...schemes].join(' or ')}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${owner}: "${value}" must not embed credentials`)
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${owner}: "${value}" must not carry a query or fragment`)
  }
  if (!isPublicHost(parsed.hostname)) {
    throw new Error(`${owner}: "${value}" host is localhost, loopback, private, or reserved`)
  }
  return parsed
}

/**
 * Validate an HTTP(S) endpoint URL a server-side request will be sent to.
 * @param value - the URL as configured.
 * @param owner - prefix naming the validating component, for the thrown message.
 * @returns the parsed URL.
 * @throws `Error` on any policy violation; see {@link assertUrl}.
 */
export function assertPublicHttpUrl(value: string, owner: string): URL {
  return assertUrl(value, HTTP_SCHEMES, owner)
}

/**
 * Validate a WS(S) endpoint URL a server-side WebSocket upgrade will be sent
 * to. The check is the HTTP policy over the upgrade schemes.
 * @param value - the URL as configured.
 * @param owner - prefix naming the validating component, for the thrown message.
 * @returns the parsed URL.
 * @throws `Error` on any policy violation; see {@link assertUrl}.
 */
export function assertPublicWebSocketUrl(value: string, owner: string): URL {
  return assertUrl(value, WEB_SOCKET_SCHEMES, owner)
}
