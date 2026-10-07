import {
  EVMClient,
  LATEST_BLOCK_NUMBER,
  TxStatus,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  prepareReportRequest,
  type Runtime,
} from "@chainlink/cre-sdk"
import { EVM_PB } from "@chainlink/cre-sdk/pb"
import { decodeFunctionResult, encodeFunctionData, toEventSelector, zeroAddress, type Address, type Hex } from "viem"
import { ICoverManagerAbi } from "../../contracts/abi"
import type { Config } from "./config"
import { MONAD_MAINNET_SELECTOR } from "./report"

/** Armed topic0 derived from the frozen ABI item, never a hand-typed signature string. */
export function armedTopic0(): Hex {
  const item = ICoverManagerAbi.find((x) => x.type === "event" && x.name === "Armed")
  if (!item || item.type !== "event") throw new Error("Armed missing from ICoverManager ABI")
  return toEventSelector(item)
}

/** Resolves the selector from the SDK table and refuses anything but the sink's constant. */
export function resolveSelector(chainSelectorName: string): bigint {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName })
  if (!network) throw new Error(`unknown network ${chainSelectorName}`)
  const selector = network.chainSelector.selector
  if (selector !== MONAD_MAINNET_SELECTOR) throw new Error(`selector ${selector} is not monad-mainnet`)
  return selector
}

export interface WatchList {
  toArm: Hex[]
  toTrigger: Hex[]
}

/** One EVM read at head: arm and trigger state moves every block, finalized would lag. */
export function readWatchList(
  runtime: Runtime<Config>,
  evm: EVMClient,
  coverManager: Address,
  perpId: bigint,
  max: number,
): WatchList {
  const data = encodeFunctionData({ abi: ICoverManagerAbi, functionName: "watchList", args: [perpId, BigInt(max)] })
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: coverManager, data }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result()
  const [toArm, toTrigger] = decodeFunctionResult({
    abi: ICoverManagerAbi,
    functionName: "watchList",
    data: bytesToHex(reply.data),
  })
  return { toArm: toArm.slice(0, max), toTrigger: toTrigger.slice(0, max) }
}

/** Signs and writes one report; throws if the tx or the receiver call failed. */
export function submitReport(runtime: Runtime<Config>, evm: EVMClient, payload: Hex, gasLimit: bigint): Hex {
  const report = runtime.report(prepareReportRequest(payload)).result()
  const res = evm
    .writeReport(runtime, {
      receiver: runtime.config.receiver,
      report,
      gasConfig: { gasLimit: gasLimit.toString() },
    })
    .result()
  const txHash = bytesToHex(res.txHash ?? new Uint8Array(32))
  runtime.log(
    `write_report txHash=${txHash} txStatus=${res.txStatus} receiverStatus=${res.receiverContractExecutionStatus} gasLimit=${gasLimit}`,
  )
  if (res.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`write failed: txStatus=${res.txStatus} ${res.errorMessage ?? ""}`.trim())
  }
  if (res.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
    throw new Error(`receiver reverted: txHash=${txHash}`)
  }
  return txHash
}
