import type { Address, Hash, Hex, PublicClient, WalletClient } from "viem"

export const NATIVE_TOKEN_ADDRESS =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address

export interface SquidChain {
  chainId: number
  networkName: string
}

export interface SourceToken {
  chain: SquidChain
  token: Address
  symbol: string
  decimals: number
  native: boolean
}

export interface DestinationRequirement {
  id: string
  chainId: number
  token: Address
  amount: bigint
  recipient: Address
}

export interface SquidQuote {
  id: string
  requestId?: string
  requirement: DestinationRequirement
  source: SourceToken
  sourceAmount: bigint
  destinationAmount: bigint
  target: Address
  /** Present only when Squid explicitly supplies a separate approval spender. */
  approvalSpender?: Address
  data: Hex
  value: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  /** Legacy routes expose gasPrice; maxFeePerGas remains the usable compatible value. */
  gasPrice?: bigint
  expiresAt: number
  estimatedRouteDurationSeconds: number
}

export interface SquidCatalog {
  chains: ReadonlyMap<number, SquidChain>
  tokens: readonly SourceToken[]
}

export interface SquidClientOptions {
  integratorId: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface SquidExecutionStep {
  kind: "approval" | "approval-reset" | "route"
  requirementId: string
  attempt: number
  nativeFee: bigint
  from: Address
  to: Address
  dataHash: Hash
  value: bigint
  nonce: number
  gas: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
  destinationMinimum?: bigint
  quoteId?: string
  requestId?: string
  fromChainId?: number
  toChainId?: number
  transactionHash?: Hash
  receiptStatus?: "success" | "reverted"
}

export interface SquidStatusReference {
  quoteId: string
  requestId?: string
  fromChainId: number
  toChainId: number
}

/** One authenticated, non-sensitive checkpoint. An intent without a hash is deliberately not resumable. */
export interface SquidExecutionCheckpoint {
  executionId: string
  steps: readonly SquidExecutionStep[]
  integrity: Hash
}

export type SquidPublicClient = Pick<
  PublicClient,
  | "estimateFeesPerGas"
  | "estimateGas"
  | "getBalance"
  | "getChainId"
  | "getTransaction"
  | "getTransactionCount"
  | "readContract"
  | "waitForTransactionReceipt"
> & {
  estimateTotalFee?: (request: {
    account: Address
    to: Address
    data: Hex
    value: bigint
    nonce: number
    gas: bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
    gasPrice?: bigint
  }) => Promise<bigint>
}

export type SquidWalletClient = Pick<
  WalletClient,
  "account" | "getAddresses" | "getChainId" | "sendTransaction"
>
