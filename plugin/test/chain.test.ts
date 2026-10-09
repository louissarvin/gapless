import { CommandError } from "@metamask/agent-wallet/plugin";
import { createPublicClient, custom } from "viem";
import { describe, expect, it } from "vitest";
import { connect } from "../src/lib/chain.js";
import { A, fakeChain, world } from "./helpers/fake.js";

// Reproduces the real failure hit on 2026-10-09: MetaMask's authenticated relay 500s for chain 143
// (`eth_chainId failed: HTTP request failed`) while the host itself is otherwise healthy.
function unreachableHost() {
  const request = async () => {
    throw new Error("HTTP request failed");
  };
  const client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }), pollingInterval: 10 });
  return {
    publicClient: () => client,
    walletStateManager: { read: () => ({}) },
    walletExecutor: async () => {
      throw new Error("must never be called by connect()");
    },
  };
}

describe("connect() RPC fallback", () => {
  it("falls back to a direct read-only client when the host's gateway is unreachable", async () => {
    const { client: fallbackChain } = fakeChain(world());
    const g = await connect(unreachableHost(), () => fallbackChain);
    expect(g.manager).toBe(A.manager);
    expect(g.factory).toBe(A.factory);
    expect(g.client).toBe(fallbackChain);
  });

  it("surfaces a clear error when both the host and the fallback are unreachable", async () => {
    const alwaysFails = () => {
      throw new Error("HTTP request failed");
    };
    const err = await connect(unreachableHost(), () => {
      const client = createPublicClient({ transport: custom({ request: alwaysFails }, { retryCount: 0 }) });
      return client;
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe("GAPLESS_RPC_ERROR");
  });

  it("never calls the fallback when the host's gateway is healthy", async () => {
    const { host, publicClient } = (await import("./helpers/fake.js")).fakeHost(world());
    let fallbackCalled = false;
    await connect(host, () => {
      fallbackCalled = true;
      return fakeChain(world()).client;
    });
    expect(publicClient).toHaveBeenCalled();
    expect(fallbackCalled).toBe(false);
  });
});
