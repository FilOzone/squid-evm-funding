import type { Address } from "viem"
import { NATIVE_TOKEN_ADDRESS, type SourceToken } from "./types.js"

interface TokenWire {
  chainId?: string | number
  address?: string
  symbol?: string
  decimals?: number
}

function invalid(message: string): never {
  throw new Error(`Invalid Squid token catalog: ${message}`)
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    invalid(`${label} must be an EVM address`)
  return value.toLowerCase() as Address
}

export function parseSourceTokens(
  response: unknown,
  sourceChainId: number,
): SourceToken[] {
  if (
    response == null ||
    typeof response !== "object" ||
    !Array.isArray((response as { tokens?: unknown }).tokens)
  )
    invalid("tokens must be an array")

  const tokens: SourceToken[] = []
  const identities = new Set<string>()
  for (const raw of (response as { tokens: TokenWire[] }).tokens) {
    if (raw == null || typeof raw !== "object") continue
    const chainId =
      typeof raw.chainId === "string" && /^\d+$/.test(raw.chainId)
        ? Number(raw.chainId)
        : raw.chainId
    if (chainId !== sourceChainId) continue
    if (typeof raw.symbol !== "string" || raw.symbol.trim() === "")
      invalid(`token on ${sourceChainId} is missing symbol`)
    if (
      typeof raw.decimals !== "number" ||
      !Number.isSafeInteger(raw.decimals) ||
      raw.decimals < 0 ||
      raw.decimals > 255
    )
      invalid(`token ${raw.symbol} on ${sourceChainId} has invalid decimals`)
    const token = address(
      raw.address,
      `token ${raw.symbol} on ${sourceChainId}`,
    )
    if (identities.has(token))
      invalid(`token ${token} on ${sourceChainId} is duplicated`)
    identities.add(token)
    tokens.push({
      chainId: sourceChainId,
      token,
      symbol: raw.symbol.trim(),
      decimals: raw.decimals,
    })
  }
  return tokens
}

export function resolveSourceToken(
  tokens: readonly SourceToken[],
  sourceChainId: number,
  selector: string,
): SourceToken {
  const candidates = tokens.filter((token) => token.chainId === sourceChainId)
  const normalized = selector.trim().toLowerCase()
  if (normalized === "native") {
    const native = candidates.filter(
      (token) => token.token === NATIVE_TOKEN_ADDRESS,
    )
    if (native.length !== 1)
      throw new Error(
        `Squid token catalog has no unambiguous native token for chain ${sourceChainId}`,
      )
    return native[0] as SourceToken
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    const exact = candidates.find(
      (token) => token.token.toLowerCase() === normalized,
    )
    if (exact == null)
      throw new Error(
        `Source token address is not supported on chain ${sourceChainId}`,
      )
    return exact
  }
  const matches = candidates.filter(
    (token) => token.symbol.toLowerCase() === normalized,
  )
  if (matches.length === 1) return matches[0] as SourceToken
  if (matches.length > 1)
    throw new Error(
      `Source token symbol ${selector} is ambiguous on chain ${sourceChainId}; use its address`,
    )
  throw new Error(
    `Source token ${selector} is not supported on chain ${sourceChainId}`,
  )
}
