import { describe, expect, it } from "vitest"
import {
  fetchSquidCatalog,
  parseSquidCatalog,
  parseSquidStatus,
  planSquidFunding,
  quoteSquidRoute,
  resolveSourceToken,
} from "./index.js"

const owner = "0x1111111111111111111111111111111111111111" as const
const sourceAddress = "0x2222222222222222222222222222222222222222" as const
const destination = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const

const chains = [
  {
    chainId: "1",
    type: "evm",
    networkName: "Ethereum",
    nativeCurrency: { symbol: "ETH", decimals: 18 },
  },
]
const tokens = [
  { chainId: "1", address: sourceAddress, symbol: "USDC", decimals: 6 },
  { chainId: "osmosis-1", address: "uosmo", symbol: "OSMO", decimals: 6 },
]

function routeFetch(
  output: (input: bigint) => bigint,
  approvalSpender?: string,
) {
  let calls = 0
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const request = JSON.parse(String(init?.body)) as {
      fromAmount: string
      slippage: number
    }
    const fromAmount = BigInt(request.fromAmount)
    return new Response(
      JSON.stringify({
        route: {
          quoteId: `quote-${calls}`,
          params: {
            fromChain: "1",
            fromToken: sourceAddress,
            fromAmount: request.fromAmount,
            fromAddress: owner,
            toChain: "314",
            toToken: destination,
            toAddress: owner,
            slippage: request.slippage,
            quoteOnly: false,
          },
          estimate: { toAmountMin: output(fromAmount).toString() },
          transactionRequest: {
            target,
            data: "0x01",
            value: "0",
            gasLimit: "1",
            maxFeePerGas: "1",
            expiry: "2000000000",
            ...(approvalSpender == null ? {} : { approvalSpender }),
          },
        },
      }),
      { status: 200 },
    )
  }
  return { fetch: fetch as typeof globalThis.fetch, calls: () => calls }
}

describe("Squid catalog and planner", () => {
  it("rejects ambiguous source symbols", () => {
    const catalog = parseSquidCatalog(chains, [
      ...tokens,
      { chainId: "1", address: target, symbol: "USDC", decimals: 6 },
    ])
    expect(() => resolveSourceToken(catalog, 1, "USDC")).toThrow("ambiguous")
  })

  it("rejects malformed token decimals", () => {
    expect(() =>
      parseSquidCatalog(chains, [
        {
          chainId: "1",
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          symbol: "ETH",
          decimals: -1,
        },
      ]),
    ).toThrow("invalid decimals")
  })

  it("accepts provider-native display and unit aliases", () => {
    const celo = [
      {
        chainId: "42220",
        type: "evm",
        networkName: "Celo",
        nativeCurrency: { symbol: "CELO", decimals: 18 },
      },
    ]
    const catalog = parseSquidCatalog(celo, [
      {
        chainId: "42220",
        address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        symbol: "CELO.native",
        decimals: 18,
      },
    ])
    expect(resolveSourceToken(catalog, 42220, "native").symbol).toBe(
      "CELO.native",
    )
    const hedera = parseSquidCatalog(
      [
        {
          chainId: "295",
          type: "evm",
          networkName: "Hedera",
          nativeCurrency: { symbol: "HBAR", decimals: 18 },
        },
      ],
      [
        {
          chainId: "295",
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          symbol: "HBAR",
          decimals: 8,
        },
      ],
    )
    expect(resolveSourceToken(hedera, 295, "native").decimals).toBe(8)
  })

  it("fetches both current Squid catalogs with the integrator ID", async () => {
    const requests: string[] = []
    const fetch = (async (url, init) => {
      requests.push(String(url))
      expect(new Headers(init?.headers).get("x-integrator-id")).toBe("test")
      return new Response(
        JSON.stringify(
          String(url).endsWith("/chains") ? { chains } : { tokens },
        ),
      )
    }) as typeof globalThis.fetch
    const catalog = await fetchSquidCatalog({
      integratorId: "test",
      baseUrl: "https://example.test/v2",
      fetch,
    })
    expect(catalog.tokens).toHaveLength(1)
    expect(requests).toEqual([
      "https://example.test/v2/chains",
      "https://example.test/v2/tokens",
    ])
  })

  it("rejects a blank integrator ID before making provider calls", async () => {
    const fetch = (() => {
      throw new Error("provider should not be called")
    }) as typeof globalThis.fetch
    await expect(
      fetchSquidCatalog({ integratorId: " ", fetch }),
    ).rejects.toThrow("integrator ID")
  })

  it("normalizes documented Squid route status values", () => {
    expect(parseSquidStatus({ squidTransactionStatus: "SUCCESS" })).toBe(
      "success",
    )
    expect(parseSquidStatus({ status: "ONGOING" })).toBe("pending")
    expect(parseSquidStatus({ status: "REFUND" })).toBe("failed")
  })

  it("keeps an explicit provider approval spender for execution validation", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const result = await quoteSquidRoute(
      {
        owner,
        source,
        requirement: {
          id: "fund",
          chainId: 314,
          token: destination,
          amount: 1n,
          recipient: owner,
        },
        sourceAmount: 1n,
        slippage: 1,
      },
      {
        integratorId: "test",
        fetch: routeFetch((amount) => amount, target).fetch,
        now: () => 0,
      },
    )
    expect(result.approvalSpender).toBe(target)
  })

  it("accepts legacy gasPrice routes with a usable compatible fee", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const original = routeFetch((amount) => amount).fetch
    const fetch = (async (url, init) => {
      const response = await original(url, init)
      const body = (await response.json()) as {
        route: { transactionRequest: Record<string, string> }
      }
      delete body.route.transactionRequest.maxFeePerGas
      body.route.transactionRequest.gasPrice = "7"
      return new Response(JSON.stringify(body))
    }) as typeof globalThis.fetch
    const result = await quoteSquidRoute(
      {
        owner,
        source,
        requirement: {
          id: "fund",
          chainId: 314,
          token: destination,
          amount: 1n,
          recipient: owner,
        },
        sourceAmount: 1n,
        slippage: 1,
      },
      { integratorId: "test", fetch, now: () => 0 },
    )
    expect(result.maxFeePerGas).toBe(7n)
    expect(result.gasPrice).toBe(7n)
  })

  it("rejects a multi-leg plan when an early route expires before return", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const original = routeFetch((amount) => amount).fetch
    const fetch = (async (url, init) => {
      const response = await original(url, init)
      const body = (await response.json()) as {
        route: { transactionRequest: { expiry: string } }
      }
      body.route.transactionRequest.expiry = "50"
      return new Response(JSON.stringify(body))
    }) as typeof globalThis.fetch
    let clock = 0
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
            {
              id: "two",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 2n,
          initialSourceAmount: 1n,
          slippage: 1,
        },
        {
          integratorId: "test",
          fetch,
          now: () => (clock++ < 2 ? 0 : 51_000),
        },
      ),
    ).rejects.toThrow("expired before planning completed")
  })

  it("rejects malformed catalog wrappers", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ chains }))) as typeof globalThis.fetch
    await expect(
      fetchSquidCatalog({ integratorId: "test", fetch }),
    ).rejects.toThrow("catalog response")
  })

  it("requotes a successful seed down to a tiny exact shortfall", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input * 10n)
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "tiny",
            chainId: 314,
            token: destination,
            amount: 1n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 500_000n,
        initialSourceAmount: 100_000n,
        slippage: 1,
      },
      { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
    )
    expect(quotes[0]?.sourceAmount).toBe(1n)
    expect(mocked.calls()).toBe(2)
  })

  it("keeps all legs under one shared source cap", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input)
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 60n,
              recipient: owner,
            },
            {
              id: "two",
              chainId: 314,
              token: destination,
              amount: 60n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 100n,
          initialSourceAmount: 50n,
          slippage: 1,
        },
        { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
      ),
    ).rejects.toThrow("source-token cap")
    expect(mocked.calls()).toBe(3)
  })

  it("rejects a route that changes the requested destination token", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input)
    const original = mocked.fetch
    mocked.fetch = (async (url, init) => {
      const response = await original(url, init)
      const body = (await response.json()) as {
        route: { params: Record<string, string> }
      }
      body.route.params.toToken = sourceAddress
      return new Response(JSON.stringify(body))
    }) as typeof globalThis.fetch
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 10n,
          initialSourceAmount: 1n,
          slippage: 1,
        },
        { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
      ),
    ).rejects.toThrow("request identity mismatch")
  })

  it("rejects malformed executable route fields", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    for (const [mutate, message] of [
      [
        (body: { route: { quoteId: string } }) => {
          body.route.quoteId = ""
        },
        "missing route fields",
      ],
      [
        (body: { route: { params: { slippage: number } } }) => {
          body.route.params.slippage = 2
        },
        "request identity mismatch",
      ],
      [
        (body: { route: { params: { quoteOnly: boolean } } }) => {
          body.route.params.quoteOnly = true
        },
        "request identity mismatch",
      ],
      [
        (body: { route: { transactionRequest: { data: string } } }) => {
          body.route.transactionRequest.data = "0x0"
        },
        "calldata",
      ],
    ] as const) {
      const mocked = routeFetch((input) => input)
      const original = mocked.fetch
      mocked.fetch = (async (url, init) => {
        const response = await original(url, init)
        const body = (await response.json()) as {
          route: Record<string, unknown>
        }
        mutate(body as never)
        return new Response(JSON.stringify(body))
      }) as typeof globalThis.fetch
      await expect(
        planSquidFunding(
          {
            owner,
            source,
            requirements: [
              {
                id: "one",
                chainId: 314,
                token: destination,
                amount: 1n,
                recipient: owner,
              },
            ],
            maxSourceAmount: 1n,
            initialSourceAmount: 1n,
            slippage: 1,
          },
          { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
        ),
      ).rejects.toThrow(message)
    }
  })

  it("uses the official inclusive slippage bounds and preserves request IDs", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input)
    const fetch = (async (url, init) => {
      const response = await mocked.fetch(url, init)
      return new Response(await response.text(), {
        headers: { "x-request-id": "header-id" },
      })
    }) as typeof globalThis.fetch
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "one",
            chainId: 314,
            token: destination,
            amount: 1n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 1n,
        initialSourceAmount: 1n,
        slippage: 99.99,
      },
      { integratorId: "test", fetch, now: () => 0 },
    )
    expect(quotes[0]?.requestId).toBe("header-id")
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 1n,
          initialSourceAmount: 1n,
          slippage: 0.009,
        },
        { integratorId: "test", fetch, now: () => 0 },
      ),
    ).rejects.toThrow("0.01")
  })

  it("normalizes unsafe route-duration metadata to zero", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input)
    const original = mocked.fetch
    mocked.fetch = (async (url, init) => {
      const response = await original(url, init)
      const body = (await response.json()) as {
        route: { estimate: { estimatedRouteDuration: number } }
      }
      body.route.estimate.estimatedRouteDuration = 1.5
      return new Response(JSON.stringify(body))
    }) as typeof globalThis.fetch
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "one",
            chainId: 314,
            token: destination,
            amount: 1n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 1n,
        initialSourceAmount: 1n,
        slippage: 1,
      },
      { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
    )
    expect(quotes[0]?.estimatedRouteDurationSeconds).toBe(0)
  })

  it("only rewrites an explicit provider minimum after downscaling", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    let calls = 0
    const fetch = (async (_url, init) => {
      calls += 1
      if (calls === 2)
        return new Response(
          JSON.stringify({ message: "below minimum amount" }),
          {
            status: 400,
          },
        )
      return routeFetch((input) => input * 10n).fetch("", init)
    }) as typeof globalThis.fetch
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 100n,
          initialSourceAmount: 10n,
          slippage: 1,
        },
        { integratorId: "test", fetch, now: () => 0 },
      ),
    ).rejects.toThrow("provider minimum")
  })

  it("retries a first minimum at the remaining cap", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    let calls = 0
    const routes = routeFetch((input) => input)
    const fetch = (async (url, init) => {
      calls += 1
      if (calls === 1)
        return new Response(
          JSON.stringify({ message: "below minimum amount" }),
          {
            status: 400,
          },
        )
      return routes.fetch(url, init)
    }) as typeof globalThis.fetch
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "one",
            chainId: 314,
            token: destination,
            amount: 80n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 100n,
        initialSourceAmount: 10n,
        slippage: 1,
      },
      { integratorId: "test", fetch, now: () => 0 },
    )
    expect(quotes[0]?.sourceAmount).toBe(80n)
    expect(calls).toBe(3)
  })

  it("recognizes nested and plain-text minimums without rewriting transient client failures", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    for (const body of [
      JSON.stringify({ error: { message: "amount below minimum" } }),
      "amount below minimum",
    ]) {
      let calls = 0
      const routes = routeFetch((input) => input)
      const fetch = (async (url, init) => {
        calls += 1
        if (calls === 1) return new Response(body, { status: 400 })
        return routes.fetch(url, init)
      }) as typeof globalThis.fetch
      await expect(
        planSquidFunding(
          {
            owner,
            source,
            requirements: [
              {
                id: "one",
                chainId: 314,
                token: destination,
                amount: 1n,
                recipient: owner,
              },
            ],
            maxSourceAmount: 10n,
            initialSourceAmount: 1n,
            slippage: 1,
          },
          { integratorId: "test", fetch, now: () => 0 },
        ),
      ).resolves.toHaveLength(1)
    }
    const transient = (async () =>
      new Response("upstream timeout", {
        status: 422,
      })) as typeof globalThis.fetch
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 10n,
          initialSourceAmount: 1n,
          slippage: 1,
        },
        { integratorId: "test", fetch: transient, now: () => 0 },
      ),
    ).rejects.toThrow("Squid quote failed (422)")
  })

  it("checks the remaining cap once before rejecting an extrapolated shortfall", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    let calls = 0
    const fetch = (async (_url, init) => {
      calls += 1
      const request = JSON.parse(String(init?.body)) as { fromAmount: string }
      return routeFetch((input) => (input === 10n ? 1n : input)).fetch("", {
        body: JSON.stringify({ ...request, slippage: 1 }),
      })
    }) as typeof globalThis.fetch
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "one",
            chainId: 314,
            token: destination,
            amount: 50n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 100n,
        initialSourceAmount: 10n,
        slippage: 1,
      },
      { integratorId: "test", fetch, now: () => 0 },
    )
    expect(quotes[0]?.sourceAmount).toBe(50n)
    expect(calls).toBe(3)
  })

  it("does not quote a later leg after the shared cap is exhausted", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const mocked = routeFetch((input) => input)
    await expect(
      planSquidFunding(
        {
          owner,
          source,
          requirements: [
            {
              id: "one",
              chainId: 314,
              token: destination,
              amount: 10n,
              recipient: owner,
            },
            {
              id: "two",
              chainId: 314,
              token: destination,
              amount: 1n,
              recipient: owner,
            },
          ],
          maxSourceAmount: 10n,
          initialSourceAmount: 10n,
          slippage: 1,
        },
        { integratorId: "test", fetch: mocked.fetch, now: () => 0 },
      ),
    ).rejects.toThrow("source-token cap")
    expect(mocked.calls()).toBe(1)
  })

  it("keeps a feasible fourth quote when fixed fees prevent convergence", async () => {
    const source = resolveSourceToken(
      parseSquidCatalog(chains, tokens),
      1,
      "USDC",
    )
    const inputs: bigint[] = []
    const outputs = new Map([
      [100n, 50n],
      [200n, 150n],
      [134n, 84n],
      [160n, 110n],
    ])
    const fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { fromAmount: string }
      const input = BigInt(request.fromAmount)
      inputs.push(input)
      return routeFetch(() => outputs.get(input) ?? 0n).fetch("", init)
    }) as typeof globalThis.fetch
    const quotes = await planSquidFunding(
      {
        owner,
        source,
        requirements: [
          {
            id: "one",
            chainId: 314,
            token: destination,
            amount: 100n,
            recipient: owner,
          },
        ],
        maxSourceAmount: 200n,
        initialSourceAmount: 100n,
        slippage: 1,
      },
      { integratorId: "test", fetch, now: () => 0 },
    )
    expect(inputs).toEqual([100n, 200n, 134n, 160n])
    expect(quotes[0]?.sourceAmount).toBe(160n)
  })
})
