import type { Address, Hash, Hex } from "viem"
import { parseSourceTokens } from "./catalog.js"
import type {
  DestinationRequirement,
  SourceToken,
  SquidClientOptions,
  SquidPriceQuote,
  SquidQuote,
  SquidQuoteCost,
  SquidRouteAction,
} from "./types.js"

const DEFAULT_BASE_URL = "https://v2.api.squidrouter.com/v2"

type RouteWire = {
  route?: {
    quoteId?: string
    params?: Record<string, unknown>
    estimate?: {
      toAmountMin?: string
      actions?: unknown
      feeCosts?: unknown
      gasCosts?: unknown
    }
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
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
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

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Invalid Squid route: ${label}`)
  return value
}

function chainId(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`Invalid Squid route: ${label}`)
  return parsed
}

function actions(
  value: unknown,
  sourceChainId: number,
  destinationChainId: number,
): SquidRouteAction[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Invalid Squid route: actions")
  const parsed = value.map((item, index) => {
    if (item == null || typeof item !== "object")
      throw new Error(`Invalid Squid route: action ${index + 1}`)
    const action = item as Record<string, unknown>
    return {
      type: text(action.type, `action ${index + 1} type`),
      fromChainId: chainId(
        action.fromChain,
        `action ${index + 1} source chain`,
      ),
      toChainId: chainId(
        action.toChain,
        `action ${index + 1} destination chain`,
      ),
      ...(typeof action.provider === "string" && action.provider.trim() !== ""
        ? { provider: action.provider }
        : {}),
      ...(typeof action.description === "string" &&
      action.description.trim() !== ""
        ? { description: action.description }
        : {}),
    }
  })
  if (
    parsed[0]?.fromChainId !== sourceChainId ||
    parsed.at(-1)?.toChainId !== destinationChainId ||
    parsed.some(
      (action, index) =>
        parsed[index + 1] != null &&
        action.toChainId !== parsed[index + 1]?.fromChainId,
    )
  )
    throw new Error("Invalid Squid route: action chain mismatch")
  return parsed
}

function costs(
  value: unknown,
  kind: SquidQuoteCost["kind"],
  routeChains: ReadonlySet<number>,
): SquidQuoteCost[] {
  if (!Array.isArray(value))
    throw new Error(`Invalid Squid route: ${kind} costs`)
  return value.map((item, index) => {
    if (item == null || typeof item !== "object")
      throw new Error(`Invalid Squid route: ${kind} cost ${index + 1}`)
    const cost = item as Record<string, unknown>
    const token = cost.token
    if (token == null || typeof token !== "object")
      throw new Error(`Invalid Squid route: ${kind} cost ${index + 1} token`)
    const tokenData = token as Record<string, unknown>
    const decimals = Number(tokenData.decimals)
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255)
      throw new Error(
        `Invalid Squid route: ${kind} cost ${index + 1} token decimals`,
      )
    const tokenChainId = chainId(
      tokenData.chainId,
      `${kind} cost ${index + 1} token chain`,
    )
    if (!routeChains.has(tokenChainId))
      throw new Error(`Invalid Squid route: ${kind} cost chain mismatch`)
    return {
      kind,
      name: text(
        kind === "fee" ? cost.name : cost.type,
        `${kind} cost ${index + 1} name`,
      ),
      amount: amount(cost.amount, `${kind} cost ${index + 1} amount`),
      ...(typeof cost.amountUSD === "string" && cost.amountUSD.trim() !== ""
        ? { amountUsd: cost.amountUSD }
        : {}),
      token: {
        address: address(
          tokenData.address,
          `${kind} cost ${index + 1} token address`,
        ),
        chainId: tokenChainId,
        symbol: text(
          tokenData.symbol,
          `${kind} cost ${index + 1} token symbol`,
        ),
        decimals,
      },
    }
  })
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

type QuoteInput = {
  owner: Address
  source: SourceToken
  requirement: DestinationRequirement
  sourceAmount: bigint
  slippage: number
}

async function requestSquidQuote(
  input: QuoteInput,
  options: SquidClientOptions,
  quoteOnly: boolean,
): Promise<{
  quote: SquidPriceQuote
  transaction?: NonNullable<
    NonNullable<RouteWire["route"]>["transactionRequest"]
  >
}> {
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
      quoteOnly,
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
    params == null ||
    (!quoteOnly && transaction == null)
  )
    throw new Error("Invalid Squid route: missing route fields")
  if (
    params.fromChain !== String(input.source.chainId) ||
    params.fromAmount !== input.sourceAmount.toString() ||
    params.toChain !== String(input.requirement.chainId) ||
    params.slippage !== input.slippage ||
    params.quoteOnly !== quoteOnly ||
    !sameAddress(params.fromToken, input.source.token) ||
    !sameAddress(params.toToken, input.requirement.token) ||
    !sameAddress(params.fromAddress, input.owner) ||
    !sameAddress(params.toAddress, input.requirement.recipient)
  )
    throw new Error("Invalid Squid route: request identity mismatch")

  const routeActions = actions(
    route.estimate?.actions,
    input.source.chainId,
    input.requirement.chainId,
  )
  const routeChains = new Set(
    routeActions.flatMap((action) => [action.fromChainId, action.toChainId]),
  )
  return {
    quote: {
      id: route.quoteId,
      requirement: input.requirement,
      sourceAmount: input.sourceAmount,
      destinationAmount: amount(
        route.estimate?.toAmountMin,
        "minimum destination amount",
      ),
      actions: routeActions,
      costs: [
        ...costs(route.estimate?.feeCosts, "fee", routeChains),
        ...costs(route.estimate?.gasCosts, "gas", routeChains),
      ],
    },
    ...(transaction == null ? {} : { transaction }),
  }
}

export async function quoteSquidPrice(
  input: {
    owner: Address
    source: SourceToken
    requirement: DestinationRequirement
    sourceAmount: bigint
    slippage: number
  },
  options: SquidClientOptions,
): Promise<SquidPriceQuote> {
  return (await requestSquidQuote(input, options, true)).quote
}

export async function quoteSquidRoute(
  input: QuoteInput,
  options: SquidClientOptions,
): Promise<SquidQuote> {
  const { quote, transaction } = await requestSquidQuote(input, options, false)
  if (transaction == null)
    throw new Error("Invalid Squid route: missing transaction request")
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
    ...quote,
    target: address(transaction.target, "target"),
    ...(approvalSpender == null ? {} : { approvalSpender }),
    data: transaction.data as Hex,
    value: amount(transaction.value ?? "0", "value"),
    expiresAt,
  }
}

export function assertTrustedSquidQuote(
  quote: SquidQuote,
  trusted: { target: Address; spender?: Address },
): SquidQuote {
  if (
    !sameAddress(quote.target, trusted.target) ||
    (quote.approvalSpender == null) !== (trusted.spender == null) ||
    (quote.approvalSpender != null &&
      trusted.spender != null &&
      !sameAddress(quote.approvalSpender, trusted.spender))
  )
    throw new Error("Squid route failed trusted target or spender checks")
  return quote
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
  // Squid returns 404 until its indexer sees the source transaction,
  // usually 5-10 seconds after execution and longer on Filecoin.
  if (response.status === 404) return "pending"
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
