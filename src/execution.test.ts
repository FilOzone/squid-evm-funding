import { type Account, decodeFunctionData, erc20Abi } from "viem"
import { describe, expect, it } from "vitest"
import {
  executeSquidFunding,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from "./index.js"

const account = "0x1111111111111111111111111111111111111111" as const
const sourceToken = "0x2222222222222222222222222222222222222222" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const

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
    expiresAt: 2_000_000_000,
    ...overrides,
  }
}

function clients(
  options: {
    allowance?: bigint
    fee?: bigint
    totalFee?: bigint
    sourceBalance?: bigint
    destinationBalances?: bigint[]
    reverted?: boolean
  } = {},
) {
  const calls = { send: 0, totalFee: 0, sent: [] as unknown[] }
  let allowance = options.allowance ?? 0n
  let destinationRead = 0
  const source = {
    getChainId: async () => 1,
    getBalance: async () => options.sourceBalance ?? 1_000n,
    getTransactionCount: async () => 7 + calls.send,
    estimateGas: async () => 2n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: options.fee ?? 3n,
      maxPriorityFeePerGas: 1n,
    }),
    estimateTotalFee:
      options.totalFee == null
        ? undefined
        : async () => {
            calls.totalFee += 1
            return options.totalFee as bigint
          },
    readContract: async (request: { functionName: string }) =>
      request.functionName === "allowance" ? allowance : 100n,
    waitForTransactionReceipt: async () => ({
      status: options.reverted ? "reverted" : "success",
    }),
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
    account: undefined as Account | undefined,
    getChainId: async () => 1,
    getAddresses: async () => [account],
    sendTransaction: async (request: unknown) => {
      calls.send += 1
      calls.sent.push(request)
      const transaction = request as { data?: `0x${string}`; to?: string }
      if (transaction.to === sourceToken && transaction.data != null) {
        const decoded = decodeFunctionData({
          abi: erc20Abi,
          data: transaction.data,
        })
        if (decoded.functionName === "approve") allowance = decoded.args[1]
      }
      return `0x${calls.send.toString().padStart(64, "a")}`
    },
  } as unknown as SquidWalletClient
  return {
    source,
    destination,
    wallet,
    calls,
    setAllowance: (amount: bigint) => {
      allowance = amount
    },
  }
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
    pollIntervalMs: 1,
  }
}

function dependencies(mocked: ReturnType<typeof clients>) {
  return {
    publicClient: mocked.source,
    walletClient: mocked.wallet,
    destinationClient: () => mocked.destination,
    refreshQuote: async (planned: SquidQuote) => ({ ...planned, id: "fresh" }),
    status: async () => "success" as const,
    now: () => 0,
    sleep: async () => {},
  }
}

describe("stateless guarded Squid execution", () => {
  it("sends exact allowance then native-value route and returns CLI-sized results", async () => {
    const mocked = clients()
    const result = await executeSquidFunding(input(), dependencies(mocked))
    expect(mocked.calls.send).toBe(2)
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
      expect.objectContaining({ to: target, value: 0n, gas: 2n }),
    )
  })

  it("resets an overbroad allowance before setting the exact route amount", async () => {
    const mocked = clients({ allowance: 20n })
    await executeSquidFunding(input(), dependencies(mocked))
    expect(mocked.calls.send).toBe(3)
    const approvals = mocked.calls.sent.slice(0, 2).map((item) =>
      decodeFunctionData({
        abi: erc20Abi,
        data: (item as { data: `0x${string}` }).data,
      }),
    )
    expect(approvals.map((approval) => approval.args[1])).toEqual([0n, 10n])
  })

  it("rejects changed route target, spender, and ERC-20 native value before sending", async () => {
    for (const changed of [
      { target: spender },
      { approvalSpender: target },
      { value: 1n },
    ]) {
      const mocked = clients({ allowance: 10n })
      const deps = dependencies(mocked)
      deps.refreshQuote = async (planned) => ({ ...planned, ...changed })
      await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
        "trust checks",
      )
      expect(mocked.calls.send).toBe(0)
    }
  })

  it("enforces source and total native-fee caps, including OP Stack total fees", async () => {
    const overSource = clients()
    await expect(
      executeSquidFunding(
        { ...input(), maxSourceAmount: 9n },
        dependencies(overSource),
      ),
    ).rejects.toThrow("source-token cap")
    const overFee = clients()
    await expect(
      executeSquidFunding(
        { ...input(), maxNativeFee: 5n },
        dependencies(overFee),
      ),
    ).rejects.toThrow("total-native-fee cap")
    const op = clients({ totalFee: 4n })
    await executeSquidFunding(
      { ...input(), feeMode: "op-stack", opStackFeeBuffer: (fee) => fee + 1n },
      dependencies(op),
    )
    expect(op.calls.totalFee).toBe(2)
    await expect(
      executeSquidFunding(
        { ...input(), feeMode: "op-stack" },
        dependencies(clients()),
      ),
    ).rejects.toThrow("OP Stack total-fee")
  })

  it("keeps Filecoin/native source reserve for all unsent routes", async () => {
    const nativeSource = {
      chain: { chainId: 314, networkName: "Filecoin" },
      token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
      symbol: "FIL",
      decimals: 18,
      native: true,
    }
    const nativeQuote = quote({
      source: nativeSource,
      value: 10n,
      target,
      requirement: { ...quote().requirement, id: "fil" },
    })
    const mocked = clients({ sourceBalance: 15n })
    const deps = dependencies(mocked)
    ;(mocked.source.getChainId as () => Promise<number>) = async () => 314
    ;(mocked.wallet.getChainId as () => Promise<number>) = async () => 314
    await expect(
      executeSquidFunding(
        {
          ...input([nativeQuote]),
          source: nativeSource,
          maxSourceAmount: 10n,
          maxNativeFee: 20n,
        },
        deps,
      ),
    ).rejects.toThrow("Native balance")
    expect(mocked.calls.send).toBe(0)
  })

  it("requires source receipt, Squid status, and destination balance", async () => {
    const reverted = clients({ reverted: true })
    await expect(
      executeSquidFunding(input(), dependencies(reverted)),
    ).rejects.toThrow("Transaction reverted")
    const incomplete = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n],
    })
    await expect(
      executeSquidFunding(
        { ...input(), maxPollAttempts: 1 },
        dependencies(incomplete),
      ),
    ).rejects.toThrow("did not complete")
  })
})
