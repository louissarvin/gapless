import { afterEach, describe, it } from "vitest";
import { monadRpcUrl, perplExchange, samplerPerps } from "../src/lib/env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("env parsing", () => {
  it("parses ENVIO_SAMPLER_PERPS and rejects anything but perp ids", (t) => {
    process.env.ENVIO_SAMPLER_PERPS = "";
    t.expect(samplerPerps()).toEqual([1]);
    process.env.ENVIO_SAMPLER_PERPS = "1, 2,2";
    t.expect(samplerPerps()).toEqual([1, 2]);
    for (const bad of ["0", "abc", "70000", "1;2", "-1", "1.5"]) {
      process.env.ENVIO_SAMPLER_PERPS = bad;
      t.expect(() => samplerPerps(), bad).toThrow(/ENVIO_SAMPLER_PERPS/);
    }
  });

  it("accepts https or local http RPC URLs and never echoes the value", (t) => {
    process.env.ENVIO_MONAD_RPC_URL = "";
    t.expect(monadRpcUrl()).toBeUndefined();
    process.env.ENVIO_MONAD_RPC_URL = "https://rpc-mainnet.monadinfra.com";
    t.expect(monadRpcUrl()).toBe("https://rpc-mainnet.monadinfra.com");
    process.env.ENVIO_MONAD_RPC_URL = "http://127.0.0.1:8545";
    t.expect(monadRpcUrl()).toBe("http://127.0.0.1:8545");
    for (const bad of ["http://rpc.example.com/secret-key", "ftp://x", "not a url secret-key"]) {
      process.env.ENVIO_MONAD_RPC_URL = bad;
      t.expect(() => monadRpcUrl()).toThrow(/ENVIO_MONAD_RPC_URL/);
      t.expect(() => monadRpcUrl()).not.toThrow(/secret-key/);
    }
  });

  it("defaults the Perpl Exchange to Constants.PERPL_EXCHANGE and validates overrides", (t) => {
    delete process.env.ENVIO_PERPL_EXCHANGE_ADDRESS;
    t.expect(perplExchange()).toBe("0x34b6552d57a35a1d042ccae1951bd1c370112a6f");
    process.env.ENVIO_PERPL_EXCHANGE_ADDRESS = "0x1234";
    t.expect(() => perplExchange()).toThrow();
  });
});
