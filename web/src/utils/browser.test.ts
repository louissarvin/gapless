import { describe, expect, it } from 'vitest'
import { isInAppBrowser } from './browser'

describe('isInAppBrowser', () => {
  it('flags a known in-app browser user agent', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]'
    expect(isInAppBrowser(ua)).toBe(true)
  })

  it('does not flag a normal mobile Safari user agent', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(isInAppBrowser(ua)).toBe(false)
  })
})
