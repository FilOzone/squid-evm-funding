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
    totalFee?: bigint
  } = {},
) {
  const calls = { send: 0, status: 0, estimateGas: 0, totalFee: 0 }
  let destinationRead = 0
  const source = {
    getChainId: async () => 1,
    getBalance: async () => 1_000n,
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
      request.functionName === "allowance" ? (options.allowance ?? 0n) : 100n,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as SquidPublicClient
  const destination = {
    ...source,
    getChainId: async () => 10,
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
    sendTransaction: async () => {
      calls.send += 1
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
    const deps = dependencies(mocked, {
      steps: [
        {
          kind: "approval",
          requirementId: "fund",
          nativeFee: 6n,
          receiptStatus: "success",
        },
        { kind: "route", requirementId: "fund", nativeFee: 6n },
      ],
    })
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "reconcile manually",
    )
    expect(mocked.calls.send).toBe(0)
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

  it("counts known checkpoint fee commitments before sending again", async () => {
    const mocked = clients({ fee: 3n })
    const checkpoint: SquidExecutionCheckpoint = {
      steps: [
        {
          kind: "approval",
          requirementId: "fund",
          nativeFee: 20n,
          receiptStatus: "success",
        },
      ],
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked, checkpoint)),
    ).rejects.toThrow("total-native-fee cap")
    expect(mocked.calls.send).toBe(0)
  })

  it("uses OP Stack total fees and fails closed without them", async () => {
    const noTotal = clients()
    await expect(
      executeSquidFunding(
        { ...input(), opStack: true, opStackFeeBuffer: (fee) => fee },
        dependencies(noTotal),
      ),
    ).rejects.toThrow("OP Stack total-fee")
    const total = clients({ totalFee: 4n })
    await executeSquidFunding(
      { ...input(), opStack: true, opStackFeeBuffer: (fee) => fee + 1n },
      dependencies(total),
    )
    expect(total.calls.totalFee).toBe(2)
    expect(total.calls.estimateGas).toBe(0)
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

  it("resumes known transactions without resubmitting them", async () => {
    const mocked = clients()
    const checkpoint: SquidExecutionCheckpoint = {
      steps: [
        {
          kind: "approval",
          requirementId: "fund",
          nativeFee: 6n,
          transactionHash: hash,
        },
        {
          kind: "route",
          requirementId: "fund",
          nativeFee: 6n,
          transactionHash: hash,
        },
      ],
    }
    await executeSquidFunding(input(), dependencies(mocked, checkpoint))
    expect(mocked.calls.send).toBe(0)
    expect(mocked.calls.status).toBe(1)
  })
})
