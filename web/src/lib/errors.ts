/**
 * Error copy mapping (ARCHITECTURE 8.7, DESIGN 9.3). Maps relay `error.code`
 * and decoded revert names to user copy. Never render the relay's raw `message`.
 */

export interface ErrorCopy {
  title: string
  body: string
  fix?: string
}

const UNKNOWN: ErrorCopy = {
  title: 'Something went wrong',
  body: 'That did not go through. Try again in a moment.',
}

const ERROR_COPY: Record<string, ErrorCopy> = {
  // Mera (ARCHITECTURE 8.7, section 1)
  PRF_UNAVAILABLE: {
    title: 'This device cannot sign in',
    body: 'Your browser or password manager does not support the passkey feature Gapless needs. iCloud Keychain, Google Password Manager, 1Password, Proton Pass and YubiKey 5 all work.',
    fix: 'Use your phone instead',
  },
  PASSKEY_OPERATION_FAILED: {
    title: 'Passkey step failed',
    body: 'The passkey ceremony did not complete. Nothing was signed.',
    fix: 'Try again',
  },
  CRYPTO_UNAVAILABLE: {
    title: 'This device cannot sign in',
    body: 'Your browser is missing a required cryptography feature.',
  },
  SESSION_ENDED: {
    title: 'Session locked',
    body: 'Your trading key session ended. Unlock it again with your passkey.',
    fix: 'Unlock with your passkey',
  },

  // Relay (ARCHITECTURE 5.1)
  NOT_FUNDED: {
    title: 'Not funded yet',
    body: 'Send AUSD to your deposit address first, then this step unlocks.',
  },
  NOT_ALLOWLISTED: {
    title: 'Gapless is invite-only for now',
    body: 'Send this address to the team to get access.',
  },
  ACCOUNT_EXISTS: {
    title: 'Account already exists',
    body: 'Your account was already created.',
  },
  SPONSOR_CAP: {
    title: 'Too many requests right now',
    body: 'The sponsor is at its limit for the moment. Try again shortly.',
  },
  SPONSOR_DISABLED: {
    title: 'Sign-ups are paused',
    body: 'The relay is not sponsoring new accounts right now. Trading and covers still work once you are set up.',
  },
  BUDGET_EXHAUSTED: {
    title: 'Sponsor budget used up for today',
    body: 'Try again after the daily reset.',
  },
  RELAY_BUSY: {
    title: 'Relay is busy',
    body: 'This will resolve on its own. Try again in a few seconds.',
  },
  IN_PROGRESS: {
    title: 'Already in progress',
    body: 'A previous request for this account is still being processed.',
  },
  NOT_SPONSORED: {
    title: 'Not sponsored',
    body: 'This account was not created through the sponsor and cannot be activated here.',
  },
  KEEPER_UNAVAILABLE: {
    title: 'Keeper is offline',
    body: 'The service that arms and triggers covers is unavailable. No new covers can be sold right now; existing covers keep their lifecycle.',
  },

  // Contract reverts (ARCHITECTURE 8.7, DESIGN 9.3)
  StopTooClose: {
    title: 'Stop is too close',
    body: 'Covers need the stop further from the mark than the current minimum distance.',
  },
  SigmaStale: {
    title: 'Pricing needs a refresh',
    body: "The volatility input for this market is older than its freshness window. We've asked for a fresh one, which takes about a minute.",
  },
  MarkStale: {
    title: 'Price feed is stale',
    body: 'The onchain mark price has not updated recently.',
  },
  OperatorBudgetExceeded: {
    title: 'Daily limit reached',
    body: 'This trading key has used up its budget for today.',
  },
  EnforcedPause: {
    title: 'Trading is paused',
    body: 'The protocol has paused this action.',
  },
  MarketPaused: {
    title: 'Market is paused',
    body: 'This market is paused by the protocol. Open covers keep their lifecycle.',
  },
  CoverShareExceeded: {
    title: 'Cover limit reached',
    body: 'This would exceed the share of your position that can be covered.',
  },
  NotionalTooLarge: {
    title: 'Trade too large',
    body: 'This trade is larger than the market allows.',
  },
  LimitOffMarket: {
    title: 'Price moved',
    body: 'The limit price is too far from the current market. Refresh and try again.',
  },
  NotionalCapExceeded: {
    title: 'Notional cap reached',
    body: 'This would exceed the maximum notional for this market.',
  },
}

export function errorCopyFor(code: string | null | undefined): ErrorCopy {
  if (!code) return UNKNOWN
  return ERROR_COPY[code] ?? UNKNOWN
}

/**
 * Formats a decoded revert into copy, filling in the contract's own numbers
 * where DESIGN 9.3 shows them inline ("Yours is 12", "has 21.40 left").
 */
export function errorCopyForRevert(
  decoded: { errorName: string; args: ReadonlyArray<unknown> } | null,
): ErrorCopy {
  if (!decoded) return UNKNOWN
  if (decoded.errorName === 'StopTooClose') {
    const [distanceBps, minBps] = decoded.args as [bigint, bigint]
    return {
      title: 'Stop is too close',
      body: `Covers need the stop at least ${minBps} bps from the mark. Yours is ${distanceBps}.`,
    }
  }
  if (decoded.errorName === 'OperatorBudgetExceeded') {
    const [, availableCNS] = decoded.args as [bigint, bigint]
    const availableAUSD = (Number(availableCNS) / 1e6).toFixed(2)
    return {
      title: 'Daily limit reached',
      body: `This trading key can move 100 AUSD a day and has ${availableAUSD} left.`,
    }
  }
  return errorCopyFor(decoded.errorName)
}
