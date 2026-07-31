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

export interface SquidQuote {
  id: string
  requirement: DestinationRequirement
  sourceAmount: bigint
  destinationAmount: bigint
  target: Address
  approvalSpender?: Address
  data: Hex
  value: bigint
  expiresAt: number
}

export interface SquidFundingPlan {
  owner: Address
  source: SourceToken
  quotes: readonly SquidQuote[]
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
  | "prepareTransactionRequest"
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
  "getChainId" | "sendTransaction"
> & { account: Account }
