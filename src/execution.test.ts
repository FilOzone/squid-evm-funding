import { type Account, decodeFunctionData, erc20Abi } from "viem"
import { describe, expect, it } from "vitest"
import {
  executeSquidFunding,
  NATIVE_TOKEN_ADDRESS,
  type SquidFundingPlan,
  type SquidPriceQuote,
  type SquidPublicClient,
  type SquidWalletClient,
} from "./index.js"

const owner = "0x1111111111111111111111111111111111111111" as const
const sourceToken = "0x2222222222222222222222222222222222222222" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const

function quote(overrides: Partial<SquidPriceQuote> = {}): SquidPriceQuote {
  return {
    id: "planned",
    requirement: {
      id: "fund",
      chainId: 314,
      token: destinationToken,
      amount: 10n,
      recipient: owner,
    },
    sourceAmount: 10n,
    destinationAmount: 10n,
    actions: [],
    costs: [],
    ...overrides,
  }
}

function nativeFee(amount: bigint) {
  return {
    kind: "fee" as const,
    name: "Gas receiver fee",
    amount,
    token: {
      address: NATIVE_TOKEN_ADDRESS,
      chainId: 1,
      symbol: "ETH",
      decimals: 18,
    },
  }
}

function plan(
  quotes: readonly SquidPriceQuote[] = [quote()],
  overrides: Partial<SquidFundingPlan> = {},
): SquidFundingPlan {
  return {
    owner,
    source: { chainId: 1, token: sourceToken, symbol: "USDC", decimals: 6 },
    quotes,
    maxSourceAmount: quotes.reduce(
      (total, item) => total + item.sourceAmount,
      0n,
    ),
    slippage: 1,
    ...overrides,
  }
}

function provider(
  options: {
    mutateRoute?: (route: Record<string, unknown>, call: number) => void
    nativeFee?: bigint
    statuses?: string[]
  } = {},
) {
  let routeCalls = 0
  let statusCalls = 0
  const fetch = (async (url, init) => {
    if (String(url).includes("/status?")) {
      const statuses = options.statuses ?? ["success"]
      const status = statuses[Math.min(statusCalls++, statuses.length - 1)]
      if (status === "http-404")
        return new Response("not found", { status: 404 })
      if (status === "network-error") throw new Error("status fetch failed")
      return new Response(JSON.stringify({ squidTransactionStatus: status }))
    }
    const request = JSON.parse(String(init?.body)) as {
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
    routeCalls += 1
    const routeNativeFee = options.nativeFee ?? 0n
    const route: Record<string, unknown> = {
      quoteId: `fresh-${routeCalls}`,
      params: { ...request },
      estimate: {
        toAmountMin: request.fromAmount,
        actions: [
          {
            type: "bridge",
            fromChain: request.fromChain,
            toChain: request.toChain,
          },
        ],
        feeCosts:
          routeNativeFee === 0n
            ? []
            : [
                {
                  name: "Gas receiver fee",
                  amount: routeNativeFee.toString(),
                  token: {
                    address: NATIVE_TOKEN_ADDRESS,
                    chainId: request.fromChain,
                    symbol: "ETH",
                    decimals: 18,
                  },
                },
              ],
        gasCosts: [],
      },
      transactionRequest: {
        target,
        approvalSpender: spender,
        data: `0x${routeCalls.toString(16).padStart(2, "0")}`,
        value: (
          (request.fromToken === NATIVE_TOKEN_ADDRESS
            ? BigInt(request.fromAmount)
            : 0n) + routeNativeFee
        ).toString(),
        expiry: "2000000000",
      },
    }
    options.mutateRoute?.(route, routeCalls)
    return new Response(JSON.stringify({ route }))
  }) as typeof globalThis.fetch
  return { fetch, routeCalls: () => routeCalls, statusCalls: () => statusCalls }
}

function clients(
  options: {
    allowance?: bigint
    feePerGas?: bigint
    totalFee?: bigint
    sourceTokenBalance?: bigint
    nativeBalance?: bigint
    destinationBalances?: bigint[]
    failDestinationReads?: number[]
    pending?: boolean
    nonceDrift?: boolean
    walletDrift?: boolean
    reverted?: boolean
  } = {},
) {
  const calls = {
    send: 0,
    totalFee: 0,
    sent: [] as Array<Record<string, unknown>>,
    prepared: [] as Array<Record<string, unknown>>,
  }
  let allowance = options.allowance ?? 0n
  let destinationRead = 0
  let pendingReads = 0
  let walletChainReads = 0
  const source = {
    getChainId: async () => 1,
    getBalance: async () => options.nativeBalance ?? 1_000n,
    getTransactionCount: async (request: { blockTag: string }) => {
      if (request.blockTag === "pending") pendingReads += 1
      if (options.pending && request.blockTag === "pending") return 8
      if (
        options.nonceDrift &&
        request.blockTag === "pending" &&
        pendingReads > 1
      )
        return 8
      return 7 + calls.send
    },
    estimateTotalFee:
      options.totalFee == null
        ? undefined
        : async () => {
            calls.totalFee += 1
            return options.totalFee as bigint
          },
    readContract: async (request: { functionName: string }) =>
      request.functionName === "allowance"
        ? allowance
        : (options.sourceTokenBalance ?? 1_000n),
    waitForTransactionReceipt: async () => ({
      status: options.reverted ? "reverted" : "success",
    }),
  } as unknown as SquidPublicClient
  const destinationBalance = async () => {
    const index = destinationRead++
    if ((options.failDestinationReads ?? []).includes(index))
      throw new Error("destination RPC unavailable")
    const balances = options.destinationBalances ?? [0n, 10n]
    return balances[Math.min(index, balances.length - 1)] as bigint
  }
  const destination = {
    ...source,
    getChainId: async () => 314,
    getBalance: destinationBalance,
    readContract: destinationBalance,
  } as unknown as SquidPublicClient
  const wallet = {
    account: { address: owner, type: "json-rpc" } as Account,
    getChainId: async () => {
      walletChainReads += 1
      return options.walletDrift && walletChainReads > 1 ? 10 : 1
    },
    prepareTransactionRequest: async (request: Record<string, unknown>) => {
      calls.prepared.push(request)
      return {
        ...request,
        account: owner,
        gas: 2n,
        maxFeePerGas: options.feePerGas ?? 3n,
        maxPriorityFeePerGas: 1n,
      }
    },
    sendTransaction: async (request: Record<string, unknown>) => {
      calls.send += 1
      calls.sent.push(request)
      if (request.to === sourceToken && typeof request.data === "string") {
        const decoded = decodeFunctionData({
          abi: erc20Abi,
          data: request.data as `0x${string}`,
        })
        if (decoded.functionName === "approve") allowance = decoded.args[1]
      }
      return `0x${calls.send.toString().padStart(64, "a")}`
    },
  } as unknown as SquidWalletClient
  return { source, destination, wallet, calls }
}

function input(
  fundingPlan = plan(),
  overrides: Partial<Parameters<typeof executeSquidFunding>[0]> = {},
) {
  return {
    plan: fundingPlan,
    maxNativeFee: 20n,
    trustedTarget: target,
    trustedSpender: spender,
    feeMode: "standard" as const,
    maxPollAttempts: 2,
    pollIntervalMs: 1,
    ...overrides,
  }
}

function dependencies(mocked: ReturnType<typeof clients>, squid = provider()) {
  return {
    publicClient: mocked.source,
    walletClient: mocked.wallet,
    destinationClient: mocked.destination,
    squid: {
      integratorId: "test",
      fetch: squid.fetch,
      now: () => 0,
    },
    sleep: async () => {},
  }
}

describe("guarded Squid execution", () => {
  it("sets an exact allowance, uses RPC-prepared requests, and returns hashes", async () => {
    const mocked = clients()
    const squid = provider()
    const result = await executeSquidFunding(
      input(),
      dependencies(mocked, squid),
    )
    expect(mocked.calls.send).toBe(2)
    expect(mocked.calls.prepared).toHaveLength(2)
    expect(result).toEqual({
      sourceAmount: 10n,
      nativeFee: 12n,
      routes: [
        {
          requirementId: "fund",
          transactionHash: `0x${"2".padStart(64, "a")}`,
        },
      ],
    })
    expect(mocked.calls.sent[0]).toEqual(
      expect.objectContaining({ to: sourceToken, gas: 2n, maxFeePerGas: 3n }),
    )
    expect(mocked.calls.sent[1]).toEqual(
      expect.objectContaining({ to: target, data: "0x01", value: 0n }),
    )
    expect(mocked.calls.sent[1]?.account).toBe(mocked.wallet.account)
    expect(squid.routeCalls()).toBe(1)
  })

  it("resets an overbroad allowance before setting the exact amount", async () => {
    const mocked = clients({ allowance: 100n })
    const squid = provider()
    await executeSquidFunding(input(), dependencies(mocked, squid))
    expect(mocked.calls.send).toBe(3)
    expect(squid.routeCalls()).toBe(1)
    const approvals = mocked.calls.sent.slice(0, 2).map((request) =>
      decodeFunctionData({
        abi: erc20Abi,
        data: request.data as `0x${string}`,
      }),
    )
    expect(approvals.map(({ args }) => args[1])).toEqual([0n, 10n])
  })

  it("rejects refreshed trust-boundary changes before a route broadcast", async () => {
    const cases: Array<{
      name: string
      mutate: (route: Record<string, unknown>) => void
    }> = [
      {
        name: "target",
        mutate: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          transaction.target = destinationToken
        },
      },
      {
        name: "spender",
        mutate: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          transaction.approvalSpender = destinationToken
        },
      },
      {
        name: "ERC-20 value",
        mutate: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          transaction.value = "1"
        },
      },
    ]
    for (const item of cases) {
      const mocked = clients({ allowance: 10n })
      const squid = provider({ mutateRoute: item.mutate })
      await expect(
        executeSquidFunding(
          input(plan([quote()])),
          dependencies(mocked, squid),
        ),
        item.name,
      ).rejects.toThrow("trust checks")
      expect(mocked.calls.send).toBe(0)
    }

    const expiring = clients()
    const expiringDependencies = dependencies(
      expiring,
      provider({
        mutateRoute: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          transaction.expiry = "1"
        },
      }),
    )
    expiringDependencies.squid.now = () =>
      expiring.calls.send === 0 ? 0 : 2_000
    await expect(
      executeSquidFunding(input(), expiringDependencies),
    ).rejects.toThrow("trust checks")
    expect(expiring.calls.send).toBe(1)
  })

  it("enforces source, native balance, and cumulative fee caps", async () => {
    const overCap = plan([quote({ sourceAmount: 11n })], {
      maxSourceAmount: 10n,
    })
    await expect(
      executeSquidFunding(input(overCap), dependencies(clients())),
    ).rejects.toThrow("source-token cap")

    const cases = [
      {
        mocked: clients({ sourceTokenBalance: 9n, allowance: 10n }),
        options: { sourceBalanceFloor: 0n },
        message: "Source-token balance",
      },
      {
        mocked: clients({ nativeBalance: 5n, allowance: 10n }),
        options: { nativeBalanceFloor: 0n },
        message: "Native balance",
      },
      {
        mocked: clients({ allowance: 10n }),
        options: { maxNativeFee: 5n },
        message: "total-native-fee cap",
      },
    ]
    for (const item of cases)
      await expect(
        executeSquidFunding(
          input(plan(), item.options),
          dependencies(item.mocked),
        ),
      ).rejects.toThrow(item.message)

    const twoLegs = plan(
      [quote(), quote({ requirement: { ...quote().requirement, id: "two" } })],
      {
        source: {
          chainId: 1,
          token: NATIVE_TOKEN_ADDRESS,
          symbol: "ETH",
          decimals: 18,
        },
      },
    )
    const mocked = clients({ destinationBalances: [0n, 10n, 0n, 10n] })
    await expect(
      executeSquidFunding(
        input(twoLegs, { maxNativeFee: 11n }),
        dependencies(mocked),
      ),
    ).rejects.toThrow("total-native-fee cap")
    expect(mocked.calls.send).toBe(1)

    const incompleteFee = clients({ allowance: 10n, feePerGas: 0n })
    await expect(
      executeSquidFunding(input(), dependencies(incompleteFee)),
    ).rejects.toThrow("Complete execution fee")
  })

  it("accepts reviewed source-chain native route fees and reserves their value", async () => {
    const planned = quote({ costs: [nativeFee(2n)] })
    const nativePlan = plan([planned], {
      source: {
        chainId: 1,
        token: NATIVE_TOKEN_ADDRESS,
        symbol: "ETH",
        decimals: 18,
      },
    })
    const nativeClients = clients({ nativeBalance: 18n })
    await expect(
      executeSquidFunding(
        input(nativePlan),
        dependencies(nativeClients, provider({ nativeFee: 2n })),
      ),
    ).resolves.toBeDefined()
    expect(nativeClients.calls.sent[0]).toEqual(
      expect.objectContaining({ value: 12n }),
    )

    await expect(
      executeSquidFunding(
        input(nativePlan),
        dependencies(
          clients({ nativeBalance: 17n }),
          provider({ nativeFee: 2n }),
        ),
      ),
    ).rejects.toThrow("route value, fee, and floor")

    const tokenClients = clients({ allowance: 10n, nativeBalance: 8n })
    await expect(
      executeSquidFunding(
        input(plan([planned])),
        dependencies(tokenClients, provider({ nativeFee: 2n })),
      ),
    ).resolves.toBeDefined()
    expect(tokenClients.calls.sent[0]).toEqual(
      expect.objectContaining({ value: 2n }),
    )
  })

  it("allows 50% native fee headroom and rejects anything above it", async () => {
    const withinCap = clients({ allowance: 10n, nativeBalance: 20_000n })
    await expect(
      executeSquidFunding(
        input(plan([quote({ costs: [nativeFee(10_000n)] })])),
        dependencies(withinCap, provider({ nativeFee: 15_000n })),
      ),
    ).resolves.toBeDefined()
    expect(withinCap.calls.sent[0]).toEqual(
      expect.objectContaining({ value: 15_000n }),
    )

    const mocked = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        input(plan([quote({ costs: [nativeFee(10_000n)] })])),
        dependencies(mocked, provider({ nativeFee: 15_001n })),
      ),
    ).rejects.toThrow("trust checks")
    expect(mocked.calls.send).toBe(0)
  })

  it("accepts prepared transaction fees when the caller selects automatic fees", async () => {
    const mocked = clients({ allowance: 100n })
    const result = await executeSquidFunding(
      input(plan(), { maxNativeFee: "auto" }),
      dependencies(mocked),
    )

    expect(mocked.calls.send).toBe(3)
    expect(result.nativeFee).toBe(18n)
  })

  it("rejects an unknown automatic fee policy", async () => {
    await expect(
      executeSquidFunding(
        input(plan(), { maxNativeFee: "automatic" as never }),
        dependencies(clients()),
      ),
    ).rejects.toThrow("Execution limits")
  })

  it("uses complete OP Stack fees and applies the caller's buffer", async () => {
    const noEstimator = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        input(plan(), {
          feeMode: "op-stack",
          opStackFeeBuffer: (fee) => fee,
        }),
        dependencies(noEstimator),
      ),
    ).rejects.toThrow("total-fee accounting")

    const buffered = clients({ allowance: 10n, totalFee: 9n })
    const result = await executeSquidFunding(
      input(plan(), {
        feeMode: "op-stack",
        maxNativeFee: 10n,
        opStackFeeBuffer: (fee) => fee + 1n,
      }),
      dependencies(buffered),
    )
    expect(result.nativeFee).toBe(10n)
    expect(buffered.calls.totalFee).toBe(1)

    const shrinking = clients({ allowance: 10n, totalFee: 9n })
    await expect(
      executeSquidFunding(
        input(plan(), {
          feeMode: "op-stack",
          opStackFeeBuffer: (fee) => fee - 1n,
        }),
        dependencies(shrinking),
      ),
    ).rejects.toThrow("must not reduce")

    const twoLegs = plan(
      [quote(), quote({ requirement: { ...quote().requirement, id: "two" } })],
      {
        source: {
          chainId: 1,
          token: NATIVE_TOKEN_ADDRESS,
          symbol: "ETH",
          decimals: 18,
        },
      },
    )
    const cumulative = clients({
      totalFee: 6n,
      destinationBalances: [0n, 10n, 0n, 10n],
    })
    await expect(
      executeSquidFunding(
        input(twoLegs, {
          feeMode: "op-stack",
          maxNativeFee: 11n,
          opStackFeeBuffer: (fee) => fee,
        }),
        dependencies(cumulative),
      ),
    ).rejects.toThrow("total-native-fee cap")
    expect(cumulative.calls.send).toBe(1)
  })

  it("fails closed on pending nonces, nonce drift, wallet drift, and reverts", async () => {
    const cases = [
      {
        mocked: clients({ allowance: 10n, pending: true }),
        message: "pending",
      },
      {
        mocked: clients({ allowance: 10n, nonceDrift: true }),
        message: "nonce changed",
      },
      {
        mocked: clients({ allowance: 10n, walletDrift: true }),
        message: "Wallet chain",
      },
      {
        mocked: clients({ allowance: 10n, reverted: true }),
        message: "reverted",
      },
    ]
    for (const item of cases)
      await expect(
        executeSquidFunding(input(), dependencies(item.mocked)),
      ).rejects.toThrow(item.message)
  })

  it("requires an account-bound wallet and matching source and destination chains", async () => {
    const wrongAccount = clients({ allowance: 10n })
    wrongAccount.wallet.account = {
      address: sourceToken,
      type: "json-rpc",
    } as Account
    await expect(
      executeSquidFunding(input(), dependencies(wrongAccount)),
    ).rejects.toThrow("does not control")

    const wrongSource = clients({ allowance: 10n })
    wrongSource.source.getChainId = async () => 10
    await expect(
      executeSquidFunding(input(), dependencies(wrongSource)),
    ).rejects.toThrow("Source RPC chain")

    const wrongDestination = clients({ allowance: 10n })
    wrongDestination.destination.getChainId = async () => 10
    await expect(
      executeSquidFunding(input(), dependencies(wrongDestination)),
    ).rejects.toThrow("Destination RPC chain")
  })

  it("rejects ambiguous requirement and polling configuration", async () => {
    const duplicate = plan([
      quote(),
      quote({ requirement: { ...quote().requirement } }),
    ])
    await expect(
      executeSquidFunding(input(duplicate), dependencies(clients())),
    ).rejects.toThrow("IDs must be unique")

    const mixedDestinations = plan([
      quote(),
      quote({
        requirement: { ...quote().requirement, id: "two", chainId: 10 },
      }),
    ])
    await expect(
      executeSquidFunding(input(mixedDestinations), dependencies(clients())),
    ).rejects.toThrow("one destination chain")

    await expect(
      executeSquidFunding(
        input(plan(), { maxPollAttempts: 0 }),
        dependencies(clients()),
      ),
    ).rejects.toThrow("Execution limits")
  })

  it("requires source receipt, Squid success, and destination arrival", async () => {
    const cases = [
      {
        mocked: clients({ allowance: 10n }),
        squid: provider({ statuses: ["failed"] }),
        message: "route failed",
      },
      {
        mocked: clients({ allowance: 10n, destinationBalances: [0n, 9n, 9n] }),
        squid: provider({ statuses: ["success"] }),
        message: "poll limit",
      },
      {
        mocked: clients({ allowance: 10n, destinationBalances: [0n, 10n] }),
        squid: provider({ statuses: ["pending", "success"] }),
        message: undefined,
      },
    ]
    for (const item of cases) {
      const promise = executeSquidFunding(
        input(),
        dependencies(item.mocked, item.squid),
      )
      if (item.message == null) await expect(promise).resolves.toBeDefined()
      else await expect(promise).rejects.toThrow(item.message)
    }

    const twoLegs = plan(
      [quote(), quote({ requirement: { ...quote().requirement, id: "two" } })],
      {
        source: {
          chainId: 1,
          token: NATIVE_TOKEN_ADDRESS,
          symbol: "ETH",
          decimals: 18,
        },
      },
    )
    const secondFails = clients({
      destinationBalances: [0n, 10n, 0n, 0n],
    })
    await expect(
      executeSquidFunding(
        input(twoLegs),
        dependencies(
          secondFails,
          provider({ statuses: ["success", "failed"] }),
        ),
      ),
    ).rejects.toThrow("route failed")
    expect(secondFails.calls.send).toBe(2)
  })

  it("treats status 404s, thrown fetches, and failed balance reads as pending", async () => {
    const indexingDelay = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        input(plan(), { maxPollAttempts: 3 }),
        dependencies(
          indexingDelay,
          provider({ statuses: ["http-404", "http-404", "success"] }),
        ),
      ),
    ).resolves.toMatchObject({ sourceAmount: 10n })

    const transientFetch = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        input(plan(), { maxPollAttempts: 2 }),
        dependencies(
          transientFetch,
          provider({ statuses: ["network-error", "success"] }),
        ),
      ),
    ).resolves.toMatchObject({ sourceAmount: 10n })

    const transientBalance = clients({
      allowance: 10n,
      failDestinationReads: [1],
    })
    await expect(
      executeSquidFunding(
        input(plan(), { maxPollAttempts: 2 }),
        dependencies(transientBalance),
      ),
    ).resolves.toMatchObject({ sourceAmount: 10n })

    const neverIndexed = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        input(plan(), { maxPollAttempts: 2 }),
        dependencies(neverIndexed, provider({ statuses: ["http-404"] })),
      ),
    ).rejects.toThrow("poll limit")
  })

  it("supports Filecoin/native sources and native destination balances with floors", async () => {
    const nativeQuote = quote({
      requirement: {
        ...quote().requirement,
        token: NATIVE_TOKEN_ADDRESS,
      },
    })
    const nativePlan = plan([nativeQuote], {
      source: {
        chainId: 1,
        token: NATIVE_TOKEN_ADDRESS,
        symbol: "ETH",
        decimals: 18,
      },
    })
    const mocked = clients({ nativeBalance: 20n })
    const result = await executeSquidFunding(
      input(nativePlan, {
        sourceBalanceFloor: 4n,
        nativeBalanceFloor: 3n,
      }),
      dependencies(mocked),
    )
    expect(result.sourceAmount).toBe(10n)
    expect(mocked.calls.send).toBe(1)
    expect(mocked.calls.sent[0]).toEqual(
      expect.objectContaining({ value: 10n }),
    )

    const insufficient = clients({ nativeBalance: 19n })
    await expect(
      executeSquidFunding(
        input(nativePlan, {
          sourceBalanceFloor: 4n,
          nativeBalanceFloor: 3n,
        }),
        dependencies(insufficient),
      ),
    ).rejects.toThrow("route value, fee, and floor")
  })

  describe("assertQuote live-route tolerance", () => {
    it("accepts an ERC-20 route whose refreshed quote omits approvalSpender", async () => {
      const mocked = clients({ allowance: 10n })
      const squid = provider({
        mutateRoute: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          delete transaction.approvalSpender
        },
      })
      await expect(
        executeSquidFunding(input(), dependencies(mocked, squid)),
      ).resolves.toBeDefined()
      expect(squid.routeCalls()).toBe(1)
    })

    it("still rejects a refreshed approvalSpender that mismatches the trusted spender", async () => {
      const mocked = clients({ allowance: 10n })
      const squid = provider({
        mutateRoute: (route) => {
          const transaction = route.transactionRequest as Record<
            string,
            unknown
          >
          transaction.approvalSpender = destinationToken
        },
      })
      await expect(
        executeSquidFunding(input(), dependencies(mocked, squid)),
      ).rejects.toThrow("trust checks")
      expect(mocked.calls.send).toBe(0)
    })

    it("accepts a refreshed route whose native value drifted up within 50% fee headroom", async () => {
      const mocked = clients({ allowance: 10n, nativeBalance: 20_000n })
      await expect(
        executeSquidFunding(
          input(plan([quote({ costs: [nativeFee(10_000n)] })])),
          dependencies(mocked, provider({ nativeFee: 10_500n })),
        ),
      ).resolves.toBeDefined()
      expect(mocked.calls.sent[0]).toEqual(
        expect.objectContaining({ value: 10_500n }),
      )
    })

    it("rejects a refreshed route whose value exceeds the 50% headroom cap", async () => {
      const mocked = clients({ allowance: 10n })
      await expect(
        executeSquidFunding(
          input(plan([quote({ costs: [nativeFee(10_000n)] })])),
          dependencies(mocked, provider({ nativeFee: 16_000n })),
        ),
      ).rejects.toThrow("trust checks")
      expect(mocked.calls.send).toBe(0)
    })

    it("rejects a refreshed route delivering below the reviewed minimum", async () => {
      const mocked = clients({ allowance: 10n })
      const squid = provider({
        mutateRoute: (route) => {
          const estimate = route.estimate as Record<string, unknown>
          estimate.toAmountMin = "9"
        },
      })
      await expect(
        executeSquidFunding(input(), dependencies(mocked, squid)),
      ).rejects.toThrow("trust checks")
      expect(mocked.calls.send).toBe(0)
    })
  })
})
