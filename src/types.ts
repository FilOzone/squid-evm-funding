import type { Address, Hex } from "viem"

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
  data: Hex
  value: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
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
