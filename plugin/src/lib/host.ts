import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { type Address, getAddress, type Hex, isAddress, type PublicClient } from "viem";
import { fail } from "./errors.js";

/**
 * Executor contract as compiled into @metamask/agent-wallet 7.0.0 (not in the public docs, see README):
 * `wallet:send-transaction` passes value and gas as bigint (the host hex-encodes them itself) and builds
 * `intent` with its `custom` factory, i.e. `{action: "custom", summary}`. Failures (FAILED, DENIED, EXPIRED,
 * BROADCAST_FAILED) throw; an interrupted poll rethrows with `pendingJob` attached.
 */
export type TxIntent = { action: "custom"; summary: string };
export type TxRequest = {
  kind: "transaction";
  chainId: number;
  transaction: { to: Address; data: Hex; value: bigint; gas: bigint };
  intent: TxIntent;
};
export type ExecResult = {
  kind: string;
  hash?: string;
  status: string;
  failureCode?: string;
  failureDescription?: string;
  pendingJob?: { pollingId?: string };
};
export type WalletExecutor = (req: TxRequest, opts?: { signal?: AbortSignal }) => Promise<ExecResult>;

/** The slice of `this.ctx` Gapless touches. `walletExecutor` is only reached on an actual submit. */
export interface Host {
  publicClient(chainId: number): PublicClient;
  walletStateManager: { read(): unknown };
  walletExecutor(io: CommandIO, source: string): Promise<unknown>;
}

type WalletRef = { id?: string; address?: string; name?: string };
type WalletEntry = { id?: string; address?: string; name?: string };
type WalletState = {
  selectedWallet?: { namespace?: string; ref?: WalletRef };
  remoteWallets?: WalletEntry[];
  byokWallets?: WalletEntry[];
};

function findByRef(list: WalletEntry[], ref: WalletRef): WalletEntry | undefined {
  if (ref.id !== undefined) return list.find((w) => w.id === ref.id);
  if (ref.address) return list.find((w) => w.address?.toLowerCase() === ref.address?.toLowerCase());
  return list.find((w) => w.name === ref.name);
}

/** Mirrors the host's own active-address lookup (selected EVM wallet by id, address or name). */
export function activeAddress(host: Pick<Host, "walletStateManager">): Address | undefined {
  const st = (host.walletStateManager.read() ?? {}) as WalletState;
  const remote = Array.isArray(st.remoteWallets) ? st.remoteWallets : [];
  const byok = Array.isArray(st.byokWallets) ? st.byokWallets : [];
  const sel = st.selectedWallet;
  let addr: string | undefined;
  if (sel?.ref && (sel.namespace === undefined || sel.namespace === "evm")) {
    addr = sel.ref.address || findByRef([...remote, ...byok], sel.ref)?.address;
  } else if (!sel && remote.length + byok.length === 1) {
    addr = [...remote, ...byok][0]?.address;
  }
  return addr && isAddress(addr, { strict: false }) ? getAddress(addr) : undefined;
}

/**
 * The executor signs with the selected wallet, so a submit must simulate from that same address.
 * The from flag only fills in when the wallet state cannot be read, and must match it otherwise.
 */
export function resolveWallet(host: Pick<Host, "walletStateManager">, from: string | undefined, forSubmit: boolean): Address {
  const active = activeAddress(host);
  const override = from?.trim() ? from.trim() : undefined;
  if (override && !isAddress(override, { strict: false })) {
    fail("GAPLESS_BAD_INPUT", "--from is not a 0x address.", "Pass the Agent Wallet address from mm wallet address.");
  }
  if (override && active && forSubmit && getAddress(override) !== active) {
    fail(
      "GAPLESS_FROM_MISMATCH",
      `--from ${getAddress(override)} is not the active wallet ${active}; Agent Wallet would sign with ${active}.`,
      "Run mm wallet select to switch wallets, or drop --from.",
    );
  }
  const wallet = override ? getAddress(override) : active;
  if (!wallet) fail("GAPLESS_NO_WALLET", "No active EVM wallet found.", "Run mm wallet show, or pass --from <address>.");
  return wallet;
}
