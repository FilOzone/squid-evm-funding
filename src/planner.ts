import type { Address } from "viem"
import { quoteSquidRoute, SquidMinimumAmountError } from "./squid.js"
import type {
  DestinationRequirement,
  SourceToken,
  SquidClientOptions,
  SquidQuote,
} from "./types.js"

const MAX_QUOTES_PER_LEG = 4

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

export async function planSquidFunding(
  input: {
    owner: Address
    source: SourceToken
    requirements: readonly DestinationRequirement[]
    maxSourceAmount: bigint
    initialSourceAmount?: bigint
    slippage: number
  },
  options: SquidClientOptions,
): Promise<SquidQuote[]> {
  if (input.maxSourceAmount <= 0n || input.requirements.length === 0)
    throw new Error(
      "A positive source cap and destination requirement are required",
    )
  const seed =
    input.initialSourceAmount ??
    5n * 10n ** BigInt(Math.max(0, input.source.decimals - 1))
  const quotes: SquidQuote[] = []
  let remaining = input.maxSourceAmount
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
            source: input.source,
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
  return quotes
}
