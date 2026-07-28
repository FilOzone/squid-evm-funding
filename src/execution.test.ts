import { decodeFunctionData, erc20Abi } from "viem"
import { describe, expect, it } from "vitest"
import {
  executeSquidFunding,
  type SquidExecutionCheckpoint,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from "./index.js"

const account = "0x1111111111111111111111111111111111111111" as const
const sourceToken = "0x2222222222222222222222222222222222222222" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const
const hash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const

function quote(overrides: Partial<SquidQuote> = {}): SquidQuote {
  return {
    id: "planned",
    source: {
      chain: { chainId: 1, networkName: "Ethereum" },
      token: sourceToken,
      symbol: "USDC",
      decimals: 6,
      native: false,
    },
    requirement: {
      id: "fund",
      chainId: 10,
      token: destinationToken,
      amount: 10n,
      recipient: account,
    },
    sourceAmount: 10n,
    destinationAmount: 10n,
    target,
    data: "0x01",
    value: 0n,
    gasLimit: 1n,
    maxFeePerGas: 1n,
    expiresAt: 2_000_000_000,
    estimatedRouteDurationSeconds: 1,
    ...overrides,
  }
}

function clients(
  options: {
    allowance?: bigint
    fee?: bigint
    destinationBalances?: bigint[]
    destinationNativeBalances?: bigint[]
    totalFee?: bigint
    sourceNativeBalance?: bigint
  } = {},
) {
  const calls: {
    send: number
    status: number
    estimateGas: number
    totalFee: number
    sent: unknown[]
  } = { send: 0, status: 0, estimateGas: 0, totalFee: 0, sent: [] }
  let destinationRead = 0
  let destinationNativeRead = 0
  let allowance = options.allowance ?? 0n
  const source = {
    getChainId: async () => 1,
    getBalance: async () => options.sourceNativeBalance ?? 1_000n,
    getTransactionCount: async () => 7,
    estimateGas: async () => {
      calls.estimateGas += 1
      return 2n
    },
    estimateFeesPerGas: async () => ({ maxFeePerGas: options.fee ?? 3n }),
    estimateTotalFee:
      options.totalFee == null
        ? undefined
        : async () => {
            calls.totalFee += 1
            return options.totalFee as bigint
          },
    readContract: async (request: { functionName: string }) =>
      request.functionName === "allowance" ? allowance : 100n,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as SquidPublicClient
  const destination = {
    ...source,
    getChainId: async () => 10,
    getBalance: async () =>
      (options.destinationNativeBalances ?? [0n, 10n])[
        Math.min(
          destinationNativeRead++,
          (options.destinationNativeBalances ?? [0n, 10n]).length - 1,
        )
      ] as bigint,
    readContract: async () =>
      (options.destinationBalances ?? [0n, 10n])[
        Math.min(
          destinationRead++,
          (options.destinationBalances ?? [0n, 10n]).length - 1,
        )
      ] as bigint,
  } as unknown as SquidPublicClient
  const wallet = {
    getAddresses: async () => [account],
    sendTransaction: async (request: unknown) => {
      calls.send += 1
      calls.sent.push(request)
      const transaction = request as { data?: `0x${string}`; to?: string }
      if (transaction.data != null && transaction.to === sourceToken) {
        const decoded = decodeFunctionData({
          abi: erc20Abi,
          data: transaction.data,
        })
        if (decoded.functionName === "approve") allowance = decoded.args[1]
      }
      return hash
    },
  } as unknown as SquidWalletClient
  return { source, destination, wallet, calls }
}

function input(quotes: readonly SquidQuote[] = [quote()]) {
  return {
    account,
    source: quotes[0]?.source as SquidQuote["source"],
    quotes,
    maxSourceAmount: 10n,
    maxNativeFee: 20n,
    trustedTarget: target,
    trustedSpender: spender,
    feeMode: "standard" as const,
    maxPollAttempts: 2,
  }
}

function dependencies(
  mocked: ReturnType<typeof clients>,
  checkpoint?: SquidExecutionCheckpoint,
) {
  let saved: SquidExecutionCheckpoint[] = []
  return {
    publicClient: mocked.source,
    walletClient: mocked.wallet,
    destinationClient: () => mocked.destination,
    refreshQuote: async (planned: SquidQuote) => ({ ...planned, id: "fresh" }),
    status: async () => {
      mocked.calls.status += 1
      return "success" as const
    },
    load: async () => checkpoint,
    save: async (next: SquidExecutionCheckpoint) => {
      saved = [...saved, next]
    },
    now: () => 0,
    saved: () => saved,
  }
}

describe("bounded Squid execution", () => {
  it("persists an intent before every broadcast", async () => {
    const mocked = clients()
    const deps = dependencies(mocked)
    await executeSquidFunding(input(), deps)
    expect(mocked.calls.send).toBe(2)
    expect(deps.saved()[0]?.steps[0]?.transactionHash).toBeUndefined()
    expect(
      deps.saved()[3]?.steps.find((item) => item.kind === "route")
        ?.transactionHash,
    ).toBeUndefined()
  })

  it("stops for manual reconciliation when an intent has no hash", async () => {
    const mocked = clients()
    const initial = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    const deps = dependencies(mocked, {
      ...initial,
      steps: initial.steps.map((step) =>
        step.kind === "route"
          ? { ...step, transactionHash: undefined, receiptStatus: undefined }
          : step,
      ),
    })
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "reconcile manually",
    )
    expect(mocked.calls.send).toBe(sends)
  })

  it("accounts for approval and route fees under one native cap", async () => {
    const mocked = clients({ fee: 3n })
    const deps = dependencies(mocked)
    await expect(
      executeSquidFunding({ ...input(), maxNativeFee: 11n }, deps),
    ).rejects.toThrow("total-native-fee cap")
    expect(mocked.calls.send).toBe(1)
    expect(mocked.calls.estimateGas).toBe(2)
  })

  it("uses getBalance for a native destination arrival", async () => {
    const mocked = clients({ destinationNativeBalances: [0n, 10n] })
    await executeSquidFunding(
      input([
        quote({
          requirement: {
            id: "fund",
            chainId: 10,
            token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            amount: 10n,
            recipient: account,
          },
        }),
      ]),
      dependencies(mocked),
    )
    expect(mocked.calls.send).toBe(2)
  })

  it("resets an overbroad allowance and sends fee-bounded transactions", async () => {
    const mocked = clients({ allowance: 20n })
    await executeSquidFunding(input(), dependencies(mocked))
    expect(mocked.calls.send).toBe(3)
    expect(mocked.calls.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gas: 2n, maxFeePerGas: 3n }),
      ]),
    )
  })

  it("rejects an ERC-20 route that carries native value", async () => {
    const mocked = clients()
    await expect(
      executeSquidFunding(input([quote({ value: 1n })]), dependencies(mocked)),
    ).rejects.toThrow("trust checks")
    expect(mocked.calls.send).toBe(0)
  })

  it("counts known checkpoint fee commitments before sending again", async () => {
    const mocked = clients({ fee: 3n })
    const initial = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    const checkpoint: SquidExecutionCheckpoint = {
      ...initial,
      steps: initial.steps
        .filter((step) => step.kind === "approval")
        .map((step) => ({ ...step, nativeFee: 20n })),
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked, checkpoint)),
    ).rejects.toThrow("total-native-fee cap")
    expect(mocked.calls.send).toBe(sends)
  })

  it("uses OP Stack total fees and fails closed without them", async () => {
    const noTotal = clients()
    await expect(
      executeSquidFunding(
        { ...input(), feeMode: "op-stack", opStackFeeBuffer: (fee) => fee },
        dependencies(noTotal),
      ),
    ).rejects.toThrow("OP Stack total-fee")
    const total = clients({ totalFee: 4n })
    await executeSquidFunding(
      { ...input(), feeMode: "op-stack", opStackFeeBuffer: (fee) => fee + 1n },
      dependencies(total),
    )
    expect(total.calls.totalFee).toBe(2)
    expect(total.calls.estimateGas).toBe(2)
  })

  it("rejects a refreshed route that changes its trusted target", async () => {
    const mocked = clients()
    const deps = dependencies(mocked)
    deps.refreshQuote = async (planned) => ({ ...planned, target: spender })
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "trust checks",
    )
    expect(mocked.calls.send).toBe(0)
  })

  it("never redirects approval to a provider-supplied spender", async () => {
    const mocked = clients()
    const deps = dependencies(mocked)
    deps.refreshQuote = async (planned) => ({
      ...planned,
      approvalSpender: target,
    })
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "trust checks",
    )
    expect(mocked.calls.send).toBe(0)
  })

  it("records and polls the refreshed route identity", async () => {
    const mocked = clients({ allowance: 10n })
    const deps = dependencies(mocked)
    let refreshes = 0
    let statusReference: unknown
    deps.refreshQuote = async (planned) => {
      refreshes += 1
      return { ...planned, id: "sent-quote", requestId: "sent-request" }
    }
    deps.status = async (status) => {
      statusReference = status
      return "success"
    }
    const checkpoint = await executeSquidFunding(input(), deps)
    expect(refreshes).toBe(1)
    expect(statusReference).toEqual({
      quoteId: "sent-quote",
      requestId: "sent-request",
      fromChainId: 1,
      toChainId: 10,
    })
    await executeSquidFunding(input(), dependencies(mocked, checkpoint))
    expect(refreshes).toBe(1)
  })

  it("re-quotes and rejects a changed target after approval", async () => {
    const mocked = clients()
    const deps = dependencies(mocked)
    let refreshes = 0
    deps.refreshQuote = async (planned) => {
      refreshes += 1
      return refreshes === 1
        ? { ...planned, id: "first" }
        : { ...planned, target: spender }
    }
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "trust checks",
    )
    expect(mocked.calls.send).toBe(1)
  })

  it("requires the exact allowance after approval", async () => {
    const mocked = clients()
    const original = mocked.source.readContract.bind(mocked.source)
    let allowanceReads = 0
    mocked.source.readContract = async (request: { functionName: string }) => {
      if (request.functionName === "allowance") {
        allowanceReads += 1
        if (allowanceReads > 1) return 0n
      }
      return original(request as never)
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked)),
    ).rejects.toThrow("Exact source-token allowance")
    expect(mocked.calls.send).toBe(1)
  })

  it("reserves only unsent native routes when resuming", async () => {
    const nativeSource = {
      chain: { chainId: 1, networkName: "Ethereum" },
      token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
      symbol: "ETH",
      decimals: 18,
      native: true,
    }
    const planned = quote({ source: nativeSource, value: 10n })
    const second = quote({
      source: nativeSource,
      value: 10n,
      requirement: { ...planned.requirement, id: "fund-2" },
    })
    const firstMocked = clients({ destinationBalances: [0n, 10n, 10n, 20n] })
    const first = await executeSquidFunding(
      { ...input([planned, second]), maxSourceAmount: 20n },
      dependencies(firstMocked),
    )
    const checkpoint = {
      ...first,
      steps: first.steps.filter(
        (step) => !(step.kind === "route" && step.requirementId === "fund-2"),
      ),
    }
    const resumed = clients({
      sourceNativeBalance: 16n,
      destinationBalances: [10n, 10n, 10n, 20n],
    })
    await executeSquidFunding(
      { ...input([planned, second]), maxSourceAmount: 20n },
      dependencies(resumed, checkpoint),
    )
    expect(resumed.calls.send).toBe(1)
  })

  it("resumes known transactions without resubmitting them", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    await executeSquidFunding(input(), dependencies(mocked, checkpoint))
    expect(mocked.calls.send).toBe(sends)
    expect(mocked.calls.status).toBe(2)
  })
})
