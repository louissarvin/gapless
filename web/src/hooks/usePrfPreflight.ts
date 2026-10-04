import { useEffect, useState } from 'react'

export type PrfPreflightResult = 'unknown' | 'supported' | 'unsupported'

interface ClientCapabilitiesApi {
  getClientCapabilities?: () => Promise<Record<string, boolean>>
}

/**
 * Best-effort PRF preflight (ARCHITECTURE `/` row):
 * `PublicKeyCredential.getClientCapabilities?.()` (`extension:prf`), only when
 * the browser exposes it. Absence of the API means "unknown", not "unsupported":
 * many PRF-capable browsers do not implement this capabilities check yet.
 */
export function usePrfPreflight(): PrfPreflightResult {
  const [result, setResult] = useState<PrfPreflightResult>('unknown')

  useEffect(() => {
    const api = (
      window as unknown as { PublicKeyCredential?: ClientCapabilitiesApi }
    ).PublicKeyCredential
    if (!api?.getClientCapabilities) return

    let cancelled = false
    api
      .getClientCapabilities()
      .then((capabilities) => {
        if (cancelled) return
        setResult(capabilities['extension:prf'] ? 'supported' : 'unsupported')
      })
      .catch(() => {
        if (!cancelled) setResult('unknown')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return result
}
