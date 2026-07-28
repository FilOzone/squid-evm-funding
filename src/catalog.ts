import type { Address } from "viem"
import {
  NATIVE_TOKEN_ADDRESS,
  type SourceToken,
  type SquidCatalog,
  type SquidChain,
} from "./types.js"

interface ChainWire {
  chainId?: string | number
  networkName?: string
  type?: string
  nativeCurrency?: { symbol?: string; decimals?: number }
}

interface TokenWire {
  chainId?: string | number
  address?: string
  symbol?: string
  decimals?: number
}

function invalid(message: string): never {
  throw new Error(`Invalid Squid catalog: ${message}`)
}

function chainId(value: unknown, label: string): number {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  )
    invalid(`${label} has an invalid chainId`)
  return parsed
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    invalid(`${label} must be an EVM address`)
  return value.toLowerCase() as Address
}

function decimals(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 255
  )
    invalid(`${label} has invalid decimals`)
  return value
}

/** Parse all EVM catalog entries. A malformed EVM entry is rejected before it can authorize a route. */
export function parseSquidCatalog(
  chainsResponse: unknown,
  tokensResponse: unknown,
): SquidCatalog {
  if (!Array.isArray(chainsResponse) || !Array.isArray(tokensResponse))
    invalid("chains and tokens must be arrays")
  const chains = new Map<number, SquidChain>()
  for (const raw of chainsResponse as ChainWire[]) {
    if (raw == null || typeof raw !== "object" || raw.type !== "evm") continue
    const id = chainId(raw.chainId, "chain")
    if (chains.has(id)) invalid(`chain ${id} is duplicated`)
    if (typeof raw.networkName !== "string" || raw.networkName.trim() === "")
      invalid(`chain ${id} is missing networkName`)
    if (
      typeof raw.nativeCurrency?.symbol !== "string" ||
      raw.nativeCurrency.symbol.trim() === ""
    )
      invalid(`chain ${id} is missing native symbol`)
    decimals(raw.nativeCurrency.decimals, `chain ${id}`)
    chains.set(id, { chainId: id, networkName: raw.networkName.trim() })
  }
  const tokens: SourceToken[] = []
  const identities = new Set<string>()
  for (const raw of tokensResponse as TokenWire[]) {
    if (raw == null || typeof raw !== "object") continue
    const id =
      typeof raw.chainId === "string" && /^\d+$/.test(raw.chainId)
        ? Number(raw.chainId)
        : raw.chainId
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue
    const chain = chains.get(id)
    if (chain == null) continue
    if (typeof raw.symbol !== "string" || raw.symbol.trim() === "")
      invalid(`token on ${id} is missing symbol`)
    const token = address(raw.address, `token ${raw.symbol} on ${id}`)
    const native = token === NATIVE_TOKEN_ADDRESS
    const tokenDecimals = decimals(raw.decimals, `token ${raw.symbol} on ${id}`)
    const identity = `${id}:${token}`
    if (identities.has(identity))
      invalid(`token ${token} on ${id} is duplicated`)
    identities.add(identity)
    tokens.push({
      chain,
      token,
      symbol: raw.symbol.trim(),
      decimals: tokenDecimals,
      native,
    })
  }
  return { chains, tokens }
}

export function resolveSourceToken(
  catalog: SquidCatalog,
  chainId: number,
  selector: string,
): SourceToken {
  const chain = catalog.chains.get(chainId)
  if (chain == null)
    throw new Error(`Squid does not support EVM chain ${chainId}`)
  const candidates = catalog.tokens.filter(
    (token) => token.chain.chainId === chainId,
  )
  if (selector.trim().toLowerCase() === "native") {
    const native = candidates.filter((token) => token.native)
    if (native.length !== 1)
      throw new Error(
        `Squid catalog has no unambiguous native token for chain ${chainId}`,
      )
    return native[0] as SourceToken
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(selector.trim())) {
    const exact = candidates.find(
      (token) => token.token.toLowerCase() === selector.trim().toLowerCase(),
    )
    if (exact == null)
      throw new Error(
        `Source token address is not supported on chain ${chainId}`,
      )
    return exact
  }
  const matches = candidates.filter(
    (token) => token.symbol.toLowerCase() === selector.trim().toLowerCase(),
  )
  if (matches.length === 1) return matches[0] as SourceToken
  if (matches.length > 1)
    throw new Error(
      `Source token symbol ${selector} is ambiguous on chain ${chainId}; use its address`,
    )
  throw new Error(
    `Source token ${selector} is not supported on chain ${chainId}`,
  )
}
