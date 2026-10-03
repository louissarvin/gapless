// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { marketWs } from './ws'

const PERP_ID = 1

/** Minimal event-target stand-in; no real socket, no network. */
class FakeWebSocket {
  static instances: Array<FakeWebSocket> = []
  listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (event: unknown) => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  removeEventListener(type: string, cb: (event: unknown) => void) {
    this.listeners.get(type)?.delete(cb)
  }

  send(_data: string) {}
  close() {}

  dispatch(type: string, event: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(event)
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no socket created')
  return socket
}

function open(socket: FakeWebSocket) {
  socket.dispatch('open', {})
}

function send(socket: FakeWebSocket, data: unknown) {
  socket.dispatch('message', { data: JSON.stringify(data) })
}

/** Gets a market to `synced` (status up, subscription, book snapshot, market state). */
function syncMarket(socket: FakeWebSocket) {
  send(socket, { mt: 9000, status: 'up' })
  send(socket, { mt: 6, subs: [{ stream: 'order-book@1', sid: 5 }] })
  send(socket, {
    mt: 15,
    sid: 5,
    bid: [{ p: 100, s: 10, o: 1 }],
    ask: [{ p: 101, s: 7, o: 1 }],
  })
  send(socket, {
    mt: 9,
    d: {
      '1': { at: { t: 1 }, mrk: 100, lst: 100, mid: 100, bid: 99, ask: 101 },
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no network in tests'))),
  )
})

afterEach(() => {
  marketWs.release(PERP_ID)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('book reducer', () => {
  it('applies a snapshot then diffs, sorted by price with removals dropped', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    send(socket, { mt: 6, subs: [{ stream: 'order-book@1', sid: 5 }] })
    send(socket, {
      mt: 15,
      sid: 5,
      bid: [
        { p: 100, s: 10, o: 1 },
        { p: 99, s: 5, o: 1 },
      ],
      ask: [{ p: 101, s: 7, o: 1 }],
    })

    expect(marketWs.getSnapshot(PERP_ID).book).toEqual({
      bids: [
        { priceScaled: 100, sizeScaled: 10 },
        { priceScaled: 99, sizeScaled: 5 },
      ],
      asks: [{ priceScaled: 101, sizeScaled: 7 }],
    })

    send(socket, {
      mt: 16,
      sid: 5,
      bid: [
        { p: 100, s: 20, o: 1 },
        { p: 99, s: 0, o: 0 },
        { p: 98, s: 3, o: 1 },
      ],
      ask: [],
    })

    expect(marketWs.getSnapshot(PERP_ID).book?.bids).toEqual([
      { priceScaled: 100, sizeScaled: 20 },
      { priceScaled: 98, sizeScaled: 3 },
    ])
  })

  it('caps the displayed book at 20 levels per side, deepest first', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    send(socket, { mt: 6, subs: [{ stream: 'order-book@1', sid: 5 }] })
    const bid = Array.from({ length: 25 }, (_, i) => ({
      p: 100 - i,
      s: 1,
      o: 1,
    }))
    send(socket, { mt: 15, sid: 5, bid, ask: [] })

    const bids = marketWs.getSnapshot(PERP_ID).book?.bids ?? []
    expect(bids).toHaveLength(20)
    expect(bids[0]?.priceScaled).toBe(100)
    expect(bids.at(-1)?.priceScaled).toBe(81)
  })

  it('ignores book frames for an unknown sid', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    send(socket, { mt: 6, subs: [{ stream: 'order-book@1', sid: 5 }] })
    send(socket, { mt: 15, sid: 999, bid: [{ p: 1, s: 1, o: 1 }], ask: [] })

    expect(marketWs.getSnapshot(PERP_ID).book).toBeNull()
  })
})

describe('status and sync', () => {
  it('is synced once a book snapshot and market state both land', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    syncMarket(socket)
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('synced')
  })

  it('marks unsynced on a down status frame and resyncs on the next snapshot', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    syncMarket(socket)
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('synced')

    send(socket, { mt: 9000, status: 'down' })
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('unsynced')

    send(socket, { mt: 9000, status: 'up' })
    // "up" alone does not resync; only a fresh mt 6 plus its snapshots do.
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('connecting')

    syncMarket(socket)
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('synced')
  })

  it('marks unsynced on a heartbeat sequence gap', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    syncMarket(socket)

    send(socket, { mt: 100, sn: 1 })
    send(socket, { mt: 100, sn: 2 })
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('synced')

    send(socket, { mt: 100, sn: 4 })
    expect(marketWs.getSnapshot(PERP_ID).status).toBe('unsynced')
  })

  it('ignores malformed frames instead of throwing', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    open(socket)
    expect(() => send(socket, { mt: 9000, status: 'sideways' })).not.toThrow()
    expect(() => send(socket, { mt: 15, sid: 'not-a-number' })).not.toThrow()
    expect(() =>
      socket.dispatch('message', { data: '{not json' }),
    ).not.toThrow()
  })
})

describe('reconnect and backoff (ARCHITECTURE 5.2)', () => {
  it('reconnects at once on 1001, fixed 16s on 1008, doubling-with-jitter otherwise', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    marketWs.acquire(PERP_ID)
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0]?.dispatch('close', { code: 1001 })
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]?.dispatch('close', { code: 1008 })
    await vi.advanceTimersByTimeAsync(15_999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // Attempt 0 after a generic close: base 1000ms, jitter 0.5 -> 750ms.
    FakeWebSocket.instances[2]?.dispatch('close', { code: 1006 })
    await vi.advanceTimersByTimeAsync(749)
    expect(FakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(4)

    // Attempt 1: base 2000ms, jitter 0.5 -> 1500ms.
    FakeWebSocket.instances[3]?.dispatch('close', { code: 1006 })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(FakeWebSocket.instances).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(5)

    randomSpy.mockRestore()
  })

  it('caps the exponential backoff at 30s', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    marketWs.acquire(PERP_ID)

    // Run enough generic-code closes to exceed the cap (base doubles past 30s quickly).
    for (let i = 0; i < 6; i++) {
      FakeWebSocket.instances.at(-1)?.dispatch('close', { code: 1006 })
      await vi.advanceTimersByTimeAsync(15_000)
    }
    const before = FakeWebSocket.instances.length
    FakeWebSocket.instances.at(-1)?.dispatch('close', { code: 1006 })
    // With jitter at 0, base/2 is the floor; capped base is 30_000, so 14_999ms must not reconnect.
    await vi.advanceTimersByTimeAsync(14_999)
    expect(FakeWebSocket.instances).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(before + 1)

    randomSpy.mockRestore()
  })

  it('sends a keepalive ping every 30s while connected', () => {
    marketWs.acquire(PERP_ID)
    const socket = lastSocket()
    const sendSpy = vi.spyOn(socket, 'send')
    open(socket)

    vi.advanceTimersByTime(30_000)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [payload] = sendSpy.mock.calls[0] ?? []
    const parsed = JSON.parse(payload)
    expect(parsed.mt).toBe(1)
    expect(typeof parsed.t).toBe('number')
  })
})
