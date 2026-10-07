import { CronCapability, EVMClient, Runner, handler, hexToBase64 } from "@chainlink/cre-sdk"
import { armedTopic0, resolveSelector } from "./src/chain"
import { configSchema, type Config, type RawConfig } from "./src/config"
import { onArmed, onRefPrice, onWatch } from "./src/handlers"

// Exports stay const arrows: Javy rejects exported function declarations that take parameters.

/** Handler order is the simulate trigger-index contract: 0 ref price, 1 watch, 2 Armed log. */
export const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  const evm = new EVMClient(resolveSelector(config.chainSelectorName))
  return [
    handler(cron.trigger({ schedule: config.schedule }), onRefPrice),
    handler(cron.trigger({ schedule: config.schedule }), onWatch),
    handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.coverManager)],
        topics: [{ values: [hexToBase64(armedTopic0())] }],
        confidence: config.logConfidence,
      }),
      onArmed,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config, RawConfig>({ configSchema })
  await runner.run(initWorkflow)
}
