// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConfirmSheet from './ConfirmSheet'
import type { TxLifecycle } from '@/lib/tx/send'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderSheet(lifecycle: TxLifecycle, onConfirm = vi.fn()) {
  render(
    <ConfirmSheet
      open
      onOpenChange={() => {}}
      title="Deposit"
      totalLabel="Depositing"
      total="100 AUSD"
      rows={[]}
      lifecycle={lifecycle}
      confirmLabel="Confirm"
      onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

async function pastInitialGuard() {
  await act(() => {
    vi.advanceTimersByTime(650)
  })
}

describe('ConfirmSheet busy state', () => {
  it('disables Confirm while simulating, not just while sending (M-2)', async () => {
    vi.useFakeTimers()
    renderSheet({ status: 'simulating' })
    await pastInitialGuard()

    // Busy during `simulating` swaps the label to the pending one and
    // disables the button: a tap here must be a no-op, not a second send.
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('disables Confirm while sending and while confirming', async () => {
    vi.useFakeTimers()
    renderSheet({ status: 'sending' })
    await pastInitialGuard()
    expect(
      screen.getByRole('button', { name: 'Sending…' }),
    ).toBeDisabled()
    cleanup()

    renderSheet({ status: 'confirming', hash: `0x${'11'.repeat(32)}` })
    await pastInitialGuard()
    expect(
      screen.getByRole('button', { name: 'Confirming…' }),
    ).toBeDisabled()
  })

  it('re-enables Confirm once idle again after the 600ms accidental-tap guard', async () => {
    vi.useFakeTimers()
    const onConfirm = renderSheet({ status: 'idle' })
    await pastInitialGuard()

    const button = screen.getByRole('button', { name: 'Confirm' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps Cancel pressable while simulating (so an AbortSignal can still stop the send)', async () => {
    vi.useFakeTimers()
    renderSheet({ status: 'simulating' })
    await pastInitialGuard()

    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled()
  })

  it('disables Cancel once broadcast: nothing left to abort', async () => {
    vi.useFakeTimers()
    renderSheet({ status: 'sending' })
    await pastInitialGuard()

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})
