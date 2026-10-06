import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // Config interpolation and the sampler read these; tests never touch the network unless a file starts the RPC stub.
    env: {
      ENVIO_START_BLOCK: "1000",
      ENVIO_SAMPLER_PERPS: "1",
      ENVIO_MONAD_RPC_URL: "",
    },
  },
});
