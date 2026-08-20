import type {
  Account,
  Address,
  Hash,
  Hex,
  PublicClient,
  WalletClient,
} from "viem"

export const NATIVE_TOKEN_ADDRESS =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address

export const SQUID_ROUTER_ADDRESS =
  "0xce16f69375520ab01377ce7b88f5ba8c48f8d666" as Address

export interface SourceToken {
  chainId: number
  token: Address
  symbol: string
  decimals: number
}

export interface DestinationRequirement {
  id: string
  chainId: number
  token: Address
  amount: bigint
  recipient: Address
}

export interface SquidRouteAction {
  type: string
  fromChainId: number
  toChainId: number
  provider?: string
  description?: string
}

export interface SquidQuoteCost {
  kind: "fee" | "gas"
  name: string
  amount: bigint
  amountUsd?: string
  token: {
    chainId: number
    symbol: string
    decimals: number
  }
}

export interface SquidPriceQuote {
  id: string
  requirement: DestinationRequirement
  sourceAmount: bigint
  destinationAmount: bigint
  actions: readonly SquidRouteAction[]
  costs: readonly SquidQuoteCost[]
}

export interface SquidQuote extends SquidPriceQuote {
  target: Address
  approvalSpender?: Address
  data: Hex
  value: bigint
  expiresAt: number
}

export interface SquidFundingPlan {
  owner: Address
  source: SourceToken
  quotes: readonly SquidPriceQuote[]
  maxSourceAmount: bigint
  slippage: number
}

export interface SquidClientOptions {
  integratorId: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface SquidExecutionResult {
  sourceAmount: bigint
  nativeFee: bigint
  routes: readonly { requirementId: string; transactionHash: Hash }[]
}

export type SquidPublicClient = Pick<
  PublicClient,
  | "getBalance"
  | "getChainId"
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
  "getChainId" | "prepareTransactionRequest" | "sendTransaction"
> & { account: Account }
