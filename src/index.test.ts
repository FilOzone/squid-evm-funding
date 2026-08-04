import { describe, expect, it } from "vitest"
import * as library from "./index.js"
import {
  assertTrustedSquidQuote,
  NATIVE_TOKEN_ADDRESS,
  planSquidFunding,
} from "./index.js"

const owner = "0x1111111111111111111111111111111111111111" as const
const sourceToken = "0x2222222222222222222222222222222222222222" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const

type RouteRequest = {
  fromAddress: string
  toAddress: string
  fromChain: string
  fromToken: string
  fromAmount: string
  toChain: string
  toToken: string
  slippage: number
  quoteOnly: boolean
}

const tokens = [
  {
    chainId: "1",
    address: sourceToken,
    symbol: "USDC",
    decimals: 6,
  },
  {
    chainId: "1",
    address: NATIVE_TOKEN_ADDRESS,
    symbol: "ETH",
    decimals: 18,
  },
  { chainId: "osmosis-1", address: "uosmo", symbol: "OSMO", decimals: 6 },
]

function requirement(id = "fund", amount = 10n) {
  return {
    id,
    chainId: 314,
    token: destinationToken,
    amount,
    recipient: owner,
  }
}

function route(
  request: RouteRequest,
  output = BigInt(request.fromAmount),
  mutate?: (value: Record<string, unknown>) => void,
) {
  const value: Record<string, unknown> = {
    route: {
      quoteId: `quote-${request.fromAmount}`,
      params: { ...request },
      estimate: {
        toAmountMin: output.toString(),
        actions: [
          {
            type: "bridge",
            fromChain: request.fromChain,
            toChain: request.toChain,
            provider: "Squid",
            description: "Bridge tokens",
          },
        ],
        feeCosts: [
          {
            name: "Service fee",
            amount: "1",
            amountUsd: "0.01",
            token: {
              chainId: request.fromChain,
              symbol: "USDC",
              decimals: 6,
            },
          },
        ],
        gasCosts: [],
      },
      transactionRequest: {
        target,
        approvalSpender: spender,
        data: "0x01",
        value:
          request.fromToken === NATIVE_TOKEN_ADDRESS ? request.fromAmount : "0",
        expiry: "2000000000",
      },
    },
  }
  mutate?.(value)
  return new Response(JSON.stringify(value))
}

function api(options: {
  tokens?: unknown
  route?: (request: RouteRequest, call: number) => Response
}) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let routeCalls = 0
  const fetch = (async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith("/tokens"))
      return new Response(JSON.stringify(options.tokens ?? { tokens }))
    const request = JSON.parse(String(init?.body)) as RouteRequest
    routeCalls += 1
    return options.route?.(request, routeCalls) ?? route(request)
  }) as typeof globalThis.fetch
  return { fetch, requests, routeCalls: () => routeCalls }
}

function plan(
  mocked: ReturnType<typeof api>,
  overrides: Partial<Parameters<typeof planSquidFunding>[0]> = {},
) {
  return planSquidFunding(
    {
      owner,
      sourceChainId: 1,
      sourceToken: "USDC",
      requirements: [requirement()],
      maxSourceAmount: "1",
      slippage: 1,
      ...overrides,
    },
    {
      integratorId: "test",
      baseUrl: "https://example.test/v2",
      fetch: mocked.fetch,
      now: () => 0,
    },
  )
}

describe("Squid funding planning", () => {
  it("keeps the runtime API to catalog, quote, planning, and execution", () => {
    expect(Object.keys(library).sort()).toEqual([
      "NATIVE_TOKEN_ADDRESS",
      "SQUID_ROUTER_ADDRESS",
      "SquidMinimumAmountError",
      "assertTrustedSquidQuote",
      "executeSquidFunding",
      "fetchSourceTokens",
      "planSquidFunding",
      "quoteSquidRoute",
      "resolveSourceToken",
    ])
  })

  it("returns review metadata and rejects an unexpected target or spender", async () => {
    const [quote] = (await plan(api({}))).quotes
    expect(quote?.actions).toEqual([
      {
        type: "bridge",
        fromChainId: 1,
        toChainId: 314,
        provider: "Squid",
        description: "Bridge tokens",
      },
    ])
    expect(quote?.costs).toEqual([
      {
        kind: "fee",
        name: "Service fee",
        amount: 1n,
        amountUsd: "0.01",
        token: { chainId: 1, symbol: "USDC", decimals: 6 },
      },
    ])
    if (quote == null) throw new Error("Expected a Squid quote")
    expect(assertTrustedSquidQuote(quote, { target, spender })).toBe(quote)
    expect(() =>
      assertTrustedSquidQuote(quote, {
        target: destinationToken,
        spender,
      }),
    ).toThrow("trusted target or spender")
  })

  it("fetches only tokens and resolves a symbol, address, or native token", async () => {
    for (const selector of ["USDC", sourceToken, "native"]) {
      const mocked = api({})
      const result = await plan(mocked, { sourceToken: selector })
      expect(result.source.token).toBe(
        selector === "native" ? NATIVE_TOKEN_ADDRESS : sourceToken,
      )
      expect(mocked.requests[0]?.url).toBe("https://example.test/v2/tokens")
      expect(
        new Headers(mocked.requests[0]?.init?.headers).get("x-integrator-id"),
      ).toBe("test")
      expect(mocked.requests.some(({ url }) => url.endsWith("/chains"))).toBe(
        false,
      )
    }
  })

  it("fails closed on malformed, duplicate, ambiguous, or missing source tokens", async () => {
    const cases = [
      {
        tokens: { tokens: [{ ...tokens[0], decimals: -1 }] },
        message: "invalid decimals",
      },
      {
        tokens: { tokens: [tokens[0], tokens[0]] },
        message: "duplicated",
      },
      {
        tokens: {
          tokens: [tokens[0], { ...tokens[0], address: target }],
        },
        message: "ambiguous",
      },
      { tokens: { tokens: [] }, message: "not supported" },
      { tokens: { nope: [] }, message: "tokens must be an array" },
    ]
    for (const item of cases)
      await expect(plan(api({ tokens: item.tokens }))).rejects.toThrow(
        item.message,
      )
  })

  it("validates the integrator ID, cap, requirements, and slippage", async () => {
    const mocked = api({})
    await expect(
      planSquidFunding(
        {
          owner,
          sourceChainId: 1,
          sourceToken: "USDC",
          requirements: [requirement()],
          maxSourceAmount: "1",
          slippage: 1,
        },
        { integratorId: " ", fetch: mocked.fetch },
      ),
    ).rejects.toThrow("integrator ID")
    expect(mocked.requests).toHaveLength(0)

    for (const overrides of [
      { maxSourceAmount: "0" },
      { maxSourceAmount: "not-an-amount" },
      { requirements: [] },
      { requirements: [requirement("fund", 0n)] },
      { requirements: [requirement(), requirement()] },
      {
        requirements: [requirement(), { ...requirement("other"), chainId: 10 }],
      },
      { slippage: 0 },
      { slippage: 100 },
    ])
      await expect(plan(api({}), overrides)).rejects.toThrow()
  })

  it("downscales a successful seed and shares one cap across all legs", async () => {
    const mocked = api({})
    const result = await plan(mocked, {
      requirements: [requirement("fil", 10n), requirement("usdfc", 5n)],
      maxSourceAmount: "0.000015",
    })
    expect(result.quotes.map(({ sourceAmount }) => sourceAmount)).toEqual([
      10n,
      5n,
    ])
    expect(result.maxSourceAmount).toBe(15n)
    expect(mocked.routeCalls()).toBe(3)

    const exhausted = api({})
    await expect(
      plan(exhausted, {
        requirements: [requirement("fil", 10n), requirement("usdfc", 6n)],
        maxSourceAmount: "0.000015",
      }),
    ).rejects.toThrow("source-token cap")
    expect(exhausted.routeCalls()).toBe(3)
  })

  it("keeps route request identity and executable fields fail closed", async () => {
    const identityChanges: Array<[string, unknown]> = [
      ["fromChain", "10"],
      ["fromToken", target],
      ["fromAmount", "11"],
      ["fromAddress", target],
      ["toChain", "10"],
      ["toToken", target],
      ["toAddress", target],
      ["slippage", 2],
      ["quoteOnly", true],
    ]
    for (const [key, changed] of identityChanges) {
      const mocked = api({
        route: (request) =>
          route(request, 10n, (value) => {
            const routeValue = value.route as {
              params: Record<string, unknown>
            }
            routeValue.params[key] = changed
          }),
      })
      await expect(plan(mocked)).rejects.toThrow("Invalid Squid route")
    }

    const transactionChanges: Array<[string, unknown]> = [
      ["target", "bad"],
      ["approvalSpender", "bad"],
      ["data", "0x0"],
      ["value", "-1"],
      ["expiry", "0"],
    ]
    for (const [key, changed] of transactionChanges)
      await expect(
        plan(
          api({
            route: (request) =>
              route(request, 10n, (value) => {
                const routeValue = value.route as {
                  transactionRequest: Record<string, unknown>
                }
                routeValue.transactionRequest[key] = changed
              }),
          }),
        ),
      ).rejects.toThrow("Invalid Squid route")

    for (const [key, changed] of [
      ["actions", []],
      ["feeCosts", [{ amount: "-1" }]],
    ] as const)
      await expect(
        plan(
          api({
            route: (request) =>
              route(request, 10n, (value) => {
                const routeValue = value.route as {
                  estimate: Record<string, unknown>
                }
                routeValue.estimate[key] = changed
              }),
          }),
        ),
      ).rejects.toThrow("Invalid Squid route")
  })

  it("ties displayed actions to a continuous requested route", async () => {
    for (const changed of [
      [{ type: "bridge", fromChain: "10", toChain: "314" }],
      [{ type: "bridge", fromChain: "1", toChain: "10" }],
      [
        { type: "swap", fromChain: "1", toChain: "10" },
        { type: "bridge", fromChain: "137", toChain: "314" },
      ],
    ])
      await expect(
        plan(
          api({
            route: (request) =>
              route(request, 10n, (value) => {
                const routeValue = value.route as {
                  estimate: Record<string, unknown>
                }
                routeValue.estimate.actions = changed
              }),
          }),
        ),
      ).rejects.toThrow("action chain mismatch")
  })

  it("handles explicit provider minimums without disguising other failures", async () => {
    const minimum = (body: unknown) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 400,
      })
    const retry = api({
      route: (request, call) =>
        call === 1
          ? minimum({ error: { message: "amount below minimum" } })
          : route(request),
    })
    await expect(plan(retry, { maxSourceAmount: "1" })).resolves.toMatchObject({
      maxSourceAmount: 1_000_000n,
    })

    const downscaled = api({
      route: (request, call) =>
        call === 1 ? route(request, 1_000_000n) : minimum("input too small"),
    })
    await expect(plan(downscaled)).rejects.toThrow("provider minimum")

    const transient = api({
      route: () =>
        new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 503,
        }),
    })
    await expect(plan(transient)).rejects.toThrow("quote failed (503)")
  })

  it("rejects expired multi-leg plans and retains a feasible fourth quote", async () => {
    const expired = api({})
    let nowCalls = 0
    await expect(
      planSquidFunding(
        {
          owner,
          sourceChainId: 1,
          sourceToken: "USDC",
          requirements: [requirement("a"), requirement("b")],
          maxSourceAmount: "1",
          slippage: 1,
        },
        {
          integratorId: "test",
          fetch: expired.fetch,
          now: () => (nowCalls++ < 4 ? 0 : 2_000_000_000_000),
        },
      ),
    ).rejects.toThrow("expired")

    const outputs = [1_000_000n, 20n, 9n, 10n]
    const converges = api({
      route: (request, call) => route(request, outputs[call - 1] as bigint),
    })
    const result = await plan(converges)
    expect(result.quotes[0]?.destinationAmount).toBe(10n)
    expect(converges.routeCalls()).toBe(4)
  })
})
