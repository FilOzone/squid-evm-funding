import { type Address, parseUnits } from "viem"
import { resolveSourceToken } from "./catalog.js"
import {
  fetchSourceTokens,
  quoteSquidRoute,
  SquidMinimumAmountError,
} from "./squid.js"
import type {
  DestinationRequirement,
  SquidClientOptions,
  SquidFundingPlan,
  SquidQuote,
} from "./types.js"

const MAX_QUOTES_PER_LEG = 4

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

export async function planSquidFunding(
  input: {
    owner: Address
    sourceChainId: number
    sourceToken: string
    requirements: readonly DestinationRequirement[]
    maxSourceAmount: string
    slippage: number
  },
  options: SquidClientOptions,
): Promise<SquidFundingPlan> {
  if (
    !Number.isSafeInteger(input.sourceChainId) ||
    input.sourceChainId <= 0 ||
    input.requirements.length === 0 ||
    input.requirements.some((requirement) => requirement.amount <= 0n)
  )
    throw new Error("A source chain and destination requirement are required")

  const source = resolveSourceToken(
    await fetchSourceTokens(input.sourceChainId, options),
    input.sourceChainId,
    input.sourceToken,
  )
  let maxSourceAmount: bigint
  try {
    maxSourceAmount = parseUnits(input.maxSourceAmount, source.decimals)
  } catch {
    throw new Error("The source-token cap must be a decimal amount")
  }
  if (maxSourceAmount <= 0n)
    throw new Error("The source-token cap must be positive")

  const seed = 5n * 10n ** BigInt(Math.max(0, source.decimals - 1))
  const quotes: SquidQuote[] = []
  let remaining = maxSourceAmount
  for (const requirement of input.requirements) {
    if (remaining <= 0n)
      throw new Error("Acquisition would exceed the source-token cap")
    let sourceAmount = seed < remaining ? seed : remaining
    let downscaled = false
    for (let attempt = 0; attempt < MAX_QUOTES_PER_LEG; attempt += 1) {
      let quote: SquidQuote
      try {
        quote = await quoteSquidRoute(
          {
            owner: input.owner,
            source,
            requirement,
            sourceAmount,
            slippage: input.slippage,
          },
          options,
        )
      } catch (error) {
        if (downscaled && error instanceof SquidMinimumAmountError)
          throw new Error(
            "Squid requires a provider minimum above the proportional source amount; fund directly rather than spending the seed quote",
            { cause: error },
          )
        if (
          !downscaled &&
          error instanceof SquidMinimumAmountError &&
          sourceAmount < remaining
        ) {
          sourceAmount = remaining
          continue
        }
        throw error
      }
      if (quote.destinationAmount <= 0n)
        throw new Error("Squid returned zero minimum destination amount")
      if (
        attempt === MAX_QUOTES_PER_LEG - 1 &&
        quote.destinationAmount >= requirement.amount
      ) {
        quotes.push(quote)
        remaining -= sourceAmount
        break
      }
      const candidate = ceilDiv(
        sourceAmount * requirement.amount,
        quote.destinationAmount,
      )
      if (
        candidate === sourceAmount &&
        quote.destinationAmount >= requirement.amount
      ) {
        quotes.push(quote)
        remaining -= sourceAmount
        break
      }
      if (candidate <= 0n)
        throw new Error("Acquisition would exceed the source-token cap")
      if (candidate > remaining) {
        if (sourceAmount < remaining) {
          sourceAmount = remaining
          continue
        }
        throw new Error("Acquisition would exceed the source-token cap")
      }
      downscaled = candidate < sourceAmount
      sourceAmount = candidate
      if (attempt === MAX_QUOTES_PER_LEG - 1)
        throw new Error(
          `Squid could not converge within ${MAX_QUOTES_PER_LEG} quotes`,
        )
    }
  }
  if (quotes.length !== input.requirements.length)
    throw new Error("Squid quote planning did not complete")
  const now = Math.floor((options.now ?? Date.now)() / 1000)
  if (quotes.some((quote) => quote.expiresAt <= now))
    throw new Error("A planned Squid route expired before planning completed")
  return {
    owner: input.owner,
    source,
    quotes,
    maxSourceAmount,
    slippage: input.slippage,
  }
}
