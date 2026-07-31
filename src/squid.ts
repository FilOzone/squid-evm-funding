import type { Address, Hash, Hex } from "viem"
import { parseSourceTokens } from "./catalog.js"
import type {
  DestinationRequirement,
  SourceToken,
  SquidClientOptions,
  SquidQuote,
} from "./types.js"

const DEFAULT_BASE_URL = "https://v2.api.squidrouter.com/v2"

type RouteWire = {
  route?: {
    quoteId?: string
    params?: Record<string, unknown>
    estimate?: { toAmountMin?: string }
    transactionRequest?: {
      target?: string
      data?: string
      value?: string
      expiry?: string
      approvalSpender?: string
    }
  }
}

export class SquidMinimumAmountError extends Error {}

function client(options: SquidClientOptions) {
  if (options.integratorId.trim() === "")
    throw new Error("Squid integrator ID is required")
  return {
    fetch: options.fetch ?? globalThis.fetch,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
  }
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error(`Invalid Squid route: ${label}`)
  return value.toLowerCase() as Address
}

function amount(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error(`Invalid Squid route: ${label}`)
  return BigInt(value)
}

function sameAddress(actual: unknown, expected: Address): boolean {
  return (
    typeof actual === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(actual) &&
    actual.toLowerCase() === expected.toLowerCase()
  )
}

function providerMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value
  if (value == null || typeof value !== "object") return undefined
  for (const key of ["message", "detail", "error"]) {
    const item = (value as Record<string, unknown>)[key]
    if (typeof item === "string") return item
    if (item != null && typeof item === "object") {
      const nested = (item as Record<string, unknown>).message
      if (typeof nested === "string") return nested
    }
  }
  return undefined
}

function isMinimumMessage(message: string | undefined): boolean {
  return (
    message != null &&
    (/\b(?:below|under|less than)\b.*\bminimum\b/i.test(message) ||
      /\bminimum\b.*\b(?:amount|input)\b/i.test(message) ||
      /\b(?:amount|input)\b.*\btoo (?:low|small)\b/i.test(message))
  )
}

export async function fetchSourceTokens(
  sourceChainId: number,
  options: SquidClientOptions,
) {
  const configured = client(options)
  const response = await configured.fetch(`${configured.baseUrl}/tokens`, {
    headers: { "x-integrator-id": options.integratorId },
  })
  if (!response.ok)
    throw new Error(`Squid tokens request failed (${response.status})`)
  return parseSourceTokens(await response.json(), sourceChainId)
}

export async function quoteSquidRoute(
  input: {
    owner: Address
    source: SourceToken
    requirement: DestinationRequirement
    sourceAmount: bigint
    slippage: number
  },
  options: SquidClientOptions,
): Promise<SquidQuote> {
  if (input.sourceAmount <= 0n || input.requirement.amount <= 0n)
    throw new Error("Source and destination amounts must be positive")
  if (
    !Number.isFinite(input.slippage) ||
    input.slippage < 0.01 ||
    input.slippage > 99.99
  )
    throw new Error("Squid slippage must be between 0.01 and 99.99")

  const configured = client(options)
  const response = await configured.fetch(`${configured.baseUrl}/route`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-integrator-id": options.integratorId,
    },
    body: JSON.stringify({
      fromAddress: input.owner,
      toAddress: input.requirement.recipient,
      fromChain: String(input.source.chainId),
      fromToken: input.source.token,
      fromAmount: input.sourceAmount.toString(),
      toChain: String(input.requirement.chainId),
      toToken: input.requirement.token,
      slippage: input.slippage,
      quoteOnly: false,
    }),
  })
  if (!response.ok) {
    let body: unknown
    try {
      const text = await response.text()
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    } catch {
      body = undefined
    }
    const message = providerMessage(body)
    if (
      (response.status === 400 || response.status === 422) &&
      isMinimumMessage(message)
    )
      throw new SquidMinimumAmountError(message)
    throw new Error(
      `Squid quote failed (${response.status})${message == null ? "" : `: ${message}`}`,
    )
  }

  const route = ((await response.json()) as RouteWire).route
  const transaction = route?.transactionRequest
  const params = route?.params
  if (
    typeof route?.quoteId !== "string" ||
    route.quoteId.trim() === "" ||
    transaction == null ||
    params == null
  )
    throw new Error("Invalid Squid route: missing route fields")
  if (
    params.fromChain !== String(input.source.chainId) ||
    params.fromAmount !== input.sourceAmount.toString() ||
    params.toChain !== String(input.requirement.chainId) ||
    params.slippage !== input.slippage ||
    params.quoteOnly !== false ||
    !sameAddress(params.fromToken, input.source.token) ||
    !sameAddress(params.toToken, input.requirement.token) ||
    !sameAddress(params.fromAddress, input.owner) ||
    !sameAddress(params.toAddress, input.requirement.recipient)
  )
    throw new Error("Invalid Squid route: request identity mismatch")
  const expiresAt = Number(transaction.expiry)
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor((options.now ?? Date.now)() / 1000)
  )
    throw new Error("Invalid Squid route: expired route")
  if (
    typeof transaction.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.data)
  )
    throw new Error("Invalid Squid route: calldata")

  const approvalSpender =
    transaction.approvalSpender == null
      ? undefined
      : address(transaction.approvalSpender, "approval spender")
  return {
    id: route.quoteId,
    requirement: input.requirement,
    sourceAmount: input.sourceAmount,
    destinationAmount: amount(
      route.estimate?.toAmountMin,
      "minimum destination amount",
    ),
    target: address(transaction.target, "target"),
    ...(approvalSpender == null ? {} : { approvalSpender }),
    data: transaction.data as Hex,
    value: amount(transaction.value ?? "0", "value"),
    expiresAt,
  }
}

export async function fetchSquidStatus(
  input: {
    quoteId: string
    transactionHash: Hash
    fromChainId: number
    toChainId: number
  },
  options: SquidClientOptions,
): Promise<"pending" | "success" | "failed"> {
  const configured = client(options)
  const query = new URLSearchParams({
    transactionId: input.transactionHash,
    fromChainId: String(input.fromChainId),
    toChainId: String(input.toChainId),
    quoteId: input.quoteId,
  })
  const response = await configured.fetch(
    `${configured.baseUrl}/status?${query}`,
    { headers: { "x-integrator-id": options.integratorId } },
  )
  if (!response.ok)
    throw new Error(`Squid status request failed (${response.status})`)
  const value = await response.json()
  const status =
    value != null && typeof value === "object"
      ? ((value as Record<string, unknown>).squidTransactionStatus ??
        (value as Record<string, unknown>).status)
      : undefined
  if (typeof status !== "string")
    throw new Error("Invalid Squid status response")
  if (status.toLowerCase() === "success") return "success"
  if (
    ["failed", "refund", "needs_gas", "partial_success"].includes(
      status.toLowerCase(),
    )
  )
    return "failed"
  return "pending"
}
