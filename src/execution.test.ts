import { type Account, decodeFunctionData, erc20Abi, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { sealSquidExecutionCheckpoint } from "./execution.js"
import {
  executeSquidFunding,
  type SquidExecutionCheckpoint,
  type SquidExecutionStep,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from "./index.js"

const account = "0x1111111111111111111111111111111111111111" as const
const sourceToken = "0x2222222222222222222222222222222222222222" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const
const thirdParty = "0x6666666666666666666666666666666666666666" as const
const hash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const
const checkpointIntegrityKey = `0x${"11".repeat(32)}` as Hex

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
    walletAccount?: Account
    walletChainId?: number
    getAddressesError?: Error
  } = {},
) {
  const calls: {
    send: number
    status: number
    estimateGas: number
    totalFee: number
    getAddresses: number
    getTransaction: number
    sent: unknown[]
    totalFeeRequests: unknown[]
  } = {
    send: 0,
    status: 0,
    estimateGas: 0,
    totalFee: 0,
    getAddresses: 0,
    getTransaction: 0,
    sent: [],
    totalFeeRequests: [],
  }
  let destinationRead = 0
  let destinationNativeRead = 0
  let allowance = options.allowance ?? 0n
  let walletChainId = options.walletChainId ?? 1
  const transactions = new Map<string, object>()
  const source = {
    getChainId: async () => 1,
    getBalance: async () => options.sourceNativeBalance ?? 1_000n,
    getTransactionCount: async () => 7 + calls.send,
    getTransaction: async ({ hash: transactionHash }: { hash: string }) => {
      calls.getTransaction += 1
      return transactions.get(transactionHash) ?? null
    },
    estimateGas: async () => {
      calls.estimateGas += 1
      return 2n
    },
    estimateFeesPerGas: async () => ({
      maxFeePerGas: options.fee ?? 3n,
      maxPriorityFeePerGas: 1n,
    }),
    estimateTotalFee:
      options.totalFee == null
        ? undefined
        : async (request: unknown) => {
            calls.totalFee += 1
            calls.totalFeeRequests.push(request)
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
    account: options.walletAccount,
    getChainId: async () => walletChainId,
    getAddresses: async () => {
      calls.getAddresses += 1
      if (options.getAddressesError != null) throw options.getAddressesError
      return [account]
    },
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
      const transactionHash = `0x${calls.send.toString().padStart(64, "a")}`
      transactions.set(transactionHash, {
        from: account,
        ...transaction,
        input: transaction.data,
      })
      return transactionHash
    },
  } as unknown as SquidWalletClient
  return {
    source,
    destination,
    wallet,
    calls,
    setAllowance: (next: bigint) => {
      allowance = next
    },
    setWalletChainId: (next: number) => {
      walletChainId = next
    },
    setTransactionFields: (
      transactionHash: string,
      fields: Record<string, unknown>,
    ) => {
      const transaction = transactions.get(transactionHash)
      if (transaction == null) throw new Error("Missing mocked transaction")
      transactions.set(transactionHash, { ...transaction, ...fields })
    },
  }
}

function input(quotes: readonly SquidQuote[] = [quote()]) {
  return {
    operationId: "test-operation",
    checkpointIntegrityKey,
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

function reseal(
  checkpoint: SquidExecutionCheckpoint,
  integrityKey: Hex = checkpointIntegrityKey,
) {
  return sealSquidExecutionCheckpoint(checkpoint, integrityKey)
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
    sleep: async () => {},
    saved: () => saved,
  }
}

async function resetOnlyRetryCheckpoint(mocked: ReturnType<typeof clients>) {
  const initial = dependencies(mocked)
  let refreshes = 0
  initial.refreshQuote = async (planned) => {
    refreshes += 1
    return refreshes === 1
      ? { ...planned, id: "before-approval" }
      : { ...planned, target: spender }
  }
  await expect(executeSquidFunding(input(), initial)).rejects.toThrow(
    "trust checks",
  )
  const approvalCheckpoint = initial.saved().at(-1)
  expect(approvalCheckpoint).toBeDefined()
  mocked.setAllowance(5n)

  const estimateGas = mocked.source.estimateGas.bind(mocked.source)
  const failAt = mocked.calls.estimateGas + 2
  mocked.source.estimateGas = async (request) => {
    const gas = await estimateGas(request)
    if (mocked.calls.estimateGas === failAt)
      throw new Error("simulated approval crash")
    return gas
  }
  const interrupted = dependencies(
    mocked,
    approvalCheckpoint as SquidExecutionCheckpoint,
  )
  await expect(
    executeSquidFunding({ ...input(), maxNativeFee: 40n }, interrupted),
  ).rejects.toThrow("simulated approval crash")
  mocked.source.estimateGas = estimateGas
  const checkpoint = interrupted.saved().at(-1)
  expect(checkpoint).toBeDefined()
  expect(
    (checkpoint as SquidExecutionCheckpoint).steps.map((step) => [
      step.kind,
      step.attempt,
    ]),
  ).toEqual([
    ["approval", 0],
    ["approval-reset", 1],
  ])
  return checkpoint as SquidExecutionCheckpoint
}

describe("bounded Squid execution", () => {
  it("rejects malformed operation IDs and integrity keys before I/O", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["blank operation ID", { operationId: " " }, "operation ID"],
      [
        "short integrity key",
        { checkpointIntegrityKey: "0x11" },
        "32-byte checkpoint integrity key",
      ],
      [
        "non-hex integrity key",
        { checkpointIntegrityKey: `0x${"gg".repeat(32)}` },
        "32-byte checkpoint integrity key",
      ],
      [
        "missing integrity key",
        { checkpointIntegrityKey: undefined },
        "32-byte checkpoint integrity key",
      ],
    ]
    for (const [name, overrides, message] of cases) {
      const mocked = clients()
      let rpcCalls = 0
      let refreshes = 0
      let loads = 0
      mocked.source.getChainId = async () => {
        rpcCalls += 1
        return 1
      }
      const deps = dependencies(mocked)
      deps.refreshQuote = async (planned) => {
        refreshes += 1
        return planned
      }
      deps.load = async () => {
        loads += 1
        return undefined
      }
      await expect(
        executeSquidFunding({ ...input(), ...overrides } as never, deps),
        name,
      ).rejects.toThrow(message)
      expect(loads, name).toBe(0)
      expect(rpcCalls, name).toBe(0)
      expect(refreshes, name).toBe(0)
      expect(mocked.calls.getAddresses, name).toBe(0)
      expect(mocked.calls.send, name).toBe(0)
    }
  })

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
    const deps = dependencies(
      mocked,
      reseal({
        ...initial,
        steps: initial.steps.map((step) =>
          step.kind === "route"
            ? { ...step, transactionHash: undefined, receiptStatus: undefined }
            : step,
        ),
      }),
    )
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

  it("uses the larger of local and quoted route gas", async () => {
    const quotedHigher = clients({ allowance: 10n })
    const quotedCheckpoint = await executeSquidFunding(
      input([quote({ gasLimit: 5n })]),
      dependencies(quotedHigher),
    )
    expect(quotedHigher.calls.sent[0]).toEqual(
      expect.objectContaining({ gas: 5n }),
    )
    expect(
      quotedCheckpoint.steps.find((step) => step.kind === "route"),
    ).toEqual(expect.objectContaining({ gas: 5n, nativeFee: 15n }))

    const capped = clients({ allowance: 10n })
    await expect(
      executeSquidFunding(
        { ...input([quote({ gasLimit: 5n })]), maxNativeFee: 14n },
        dependencies(capped),
      ),
    ).rejects.toThrow("total-native-fee cap")
    expect(capped.calls.send).toBe(0)

    const localHigher = clients({ allowance: 10n })
    const localCheckpoint = await executeSquidFunding(
      input(),
      dependencies(localHigher),
    )
    expect(localCheckpoint.steps.find((step) => step.kind === "route")).toEqual(
      expect.objectContaining({ gas: 2n, nativeFee: 6n }),
    )
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

  it("preserves the larger floor when native source also pays gas", async () => {
    const nativeSource = {
      chain: { chainId: 1, networkName: "Ethereum" },
      token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
      symbol: "ETH",
      decimals: 18,
      native: true,
    }
    const mocked = clients({ sourceNativeBalance: 110n })
    await expect(
      executeSquidFunding(
        {
          ...input([quote({ source: nativeSource, value: 10n })]),
          sourceBalanceFloor: 100n,
          nativeBalanceFloor: 10n,
        },
        dependencies(mocked),
      ),
    ).rejects.toThrow("source amount, fee, and floor")
    expect(mocked.calls.send).toBe(0)
  })

  it("supports a destination recipient distinct from the signer", async () => {
    const mocked = clients()
    await executeSquidFunding(
      input([
        quote({
          requirement: { ...quote().requirement, recipient: thirdParty },
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
    const checkpoint = reseal({
      ...initial,
      steps: initial.steps.filter((step) => step.kind === "approval"),
    })
    await expect(
      executeSquidFunding(
        { ...input(), maxNativeFee: 5n },
        dependencies(mocked, checkpoint),
      ),
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
    for (const [index, feeRequest] of total.calls.totalFeeRequests.entries()) {
      expect(total.calls.sent[index]).toEqual({
        ...(feeRequest as object),
        chain: undefined,
      })
    }
    expect(total.calls.totalFeeRequests[0]).toEqual(
      expect.objectContaining({
        gas: 2n,
        maxFeePerGas: 3n,
        maxPriorityFeePerGas: 1n,
      }),
    )
  })

  it("rejects a lowered authenticated OP Stack fee before the next send", async () => {
    const first = quote()
    const second = quote({
      requirement: { ...first.requirement, id: "fund-2" },
    })
    const mocked = clients({ totalFee: 4n })
    const interrupted = dependencies(mocked)
    interrupted.refreshQuote = async (planned) => {
      if (planned.requirement.id === "fund-2")
        throw new Error("simulated interruption")
      return { ...planned, id: "fresh" }
    }
    await expect(
      executeSquidFunding(
        {
          ...input([first, second]),
          maxSourceAmount: 20n,
          maxNativeFee: 20n,
          feeMode: "op-stack",
          opStackFeeBuffer: (fee) => fee,
        },
        interrupted,
      ),
    ).rejects.toThrow("simulated interruption")
    const checkpoint = interrupted.saved().at(-1)
    expect(checkpoint).toBeDefined()
    const forged = {
      ...(checkpoint as SquidExecutionCheckpoint),
      steps: (checkpoint as SquidExecutionCheckpoint).steps.map((step) =>
        step.kind === "route"
          ? { ...step, nativeFee: step.nativeFee - 1n }
          : step,
      ),
    }
    const sends = mocked.calls.send
    const transactionReads = mocked.calls.getTransaction
    let rpcCalls = 0
    let refreshes = 0
    mocked.source.getChainId = async () => {
      rpcCalls += 1
      return 1
    }
    const resumed = dependencies(mocked, forged)
    resumed.refreshQuote = async (planned) => {
      refreshes += 1
      return planned
    }
    await expect(
      executeSquidFunding(
        {
          ...input([first, second]),
          maxSourceAmount: 20n,
          maxNativeFee: 20n,
          feeMode: "op-stack",
          opStackFeeBuffer: (fee) => fee,
        },
        resumed,
      ),
    ).rejects.toThrow("Checkpoint integrity verification failed")
    expect(rpcCalls).toBe(0)
    expect(refreshes).toBe(0)
    expect(mocked.calls.getTransaction).toBe(transactionReads)
    expect(mocked.calls.send).toBe(sends)
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

  it("rejects malformed refreshed route metadata before broadcast", async () => {
    const cases: Array<[string, Partial<SquidQuote>]> = [
      ["undefined expiry", { expiresAt: undefined as unknown as number }],
      ["NaN expiry", { expiresAt: Number.NaN }],
      ["unsafe expiry", { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
      ["zero gas", { gasLimit: 0n }],
      ["negative gas", { gasLimit: -1n }],
      ["non-bigint gas", { gasLimit: 1 as unknown as bigint }],
      [
        "non-bigint destination",
        { destinationAmount: undefined as unknown as bigint },
      ],
      ["insufficient destination", { destinationAmount: 9n }],
      ["blank quote ID", { id: " " }],
      ["blank request ID", { requestId: " " }],
    ]
    for (const [name, overrides] of cases) {
      const mocked = clients({ allowance: 10n })
      const deps = dependencies(mocked)
      deps.refreshQuote = async (planned) => ({ ...planned, ...overrides })
      await expect(executeSquidFunding(input(), deps), name).rejects.toThrow(
        "trust checks",
      )
      expect(mocked.calls.send, name).toBe(0)
    }
  })

  it("rechecks each quote expiry at its actual send boundary", async () => {
    const first = quote()
    const second = quote({
      requirement: { ...first.requirement, id: "fund-2" },
    })
    const mocked = clients({ allowance: 10n })
    const estimateGas = mocked.source.estimateGas.bind(mocked.source)
    let clock = 0
    mocked.source.estimateGas = async (request) => {
      const gas = await estimateGas(request)
      if (mocked.calls.estimateGas === 2) clock = second.expiresAt * 1_000
      return gas
    }
    const deps = dependencies(mocked)
    deps.now = () => clock
    await expect(
      executeSquidFunding(
        { ...input([first, second]), maxSourceAmount: 20n },
        deps,
      ),
    ).rejects.toThrow("trust checks")
    expect(mocked.calls.send).toBe(1)
  })

  it("clears an unsent route intent when it expires during checkpoint save", async () => {
    const planned = quote()
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 10n],
    })
    const deps = dependencies(mocked)
    const save = deps.save
    let clock = 0
    deps.now = () => clock
    deps.save = async (checkpoint) => {
      await save(checkpoint)
      if (
        checkpoint.steps.some(
          (step) => step.kind === "route" && step.transactionHash == null,
        )
      )
        clock = planned.expiresAt * 1_000
    }
    await expect(executeSquidFunding(input([planned]), deps)).rejects.toThrow(
      "trust checks",
    )
    expect(mocked.calls.send).toBe(0)
    const resumable = deps.saved().at(-1)
    expect(resumable?.steps).toEqual([])

    await executeSquidFunding(input([planned]), dependencies(mocked, resumable))
    expect(mocked.calls.send).toBe(1)
  })

  it("clears an unsent intent when the wallet switches chains during save", async () => {
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 10n],
    })
    const deps = dependencies(mocked)
    const save = deps.save
    deps.save = async (checkpoint) => {
      await save(checkpoint)
      if (
        checkpoint.steps.some(
          (step) => step.kind === "route" && step.transactionHash == null,
        )
      )
        mocked.setWalletChainId(10)
    }
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "Wallet chain",
    )
    expect(mocked.calls.send).toBe(0)
    const resumable = deps.saved().at(-1)
    expect(resumable?.steps).toEqual([])

    mocked.setWalletChainId(1)
    await executeSquidFunding(input(), dependencies(mocked, resumable))
    expect(mocked.calls.send).toBe(1)
  })

  it("rechecks the wallet chain before a later route broadcast", async () => {
    const mocked = clients({ destinationBalances: [0n, 0n, 10n] })
    const deps = dependencies(mocked)
    const save = deps.save
    deps.save = async (checkpoint) => {
      await save(checkpoint)
      if (
        checkpoint.steps.some(
          (step) => step.kind === "route" && step.transactionHash == null,
        )
      )
        mocked.setWalletChainId(10)
    }
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "Wallet chain",
    )
    expect(mocked.calls.send).toBe(1)
    const resumable = deps.saved().at(-1)
    expect(resumable?.steps.some((step) => step.transactionHash == null)).toBe(
      false,
    )

    mocked.setWalletChainId(1)
    const completed = await executeSquidFunding(
      input(),
      dependencies(mocked, resumable),
    )
    expect(mocked.calls.send).toBe(2)
    await executeSquidFunding(input(), dependencies(mocked, completed))
    expect(mocked.calls.send).toBe(2)
  })

  it("clears an unsent intent when the pending nonce changes during save", async () => {
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 10n],
    })
    let pendingNonce = 7
    mocked.source.getTransactionCount = async () => pendingNonce
    const deps = dependencies(mocked)
    const save = deps.save
    deps.save = async (checkpoint) => {
      await save(checkpoint)
      if (
        checkpoint.steps.some(
          (step) => step.kind === "route" && step.transactionHash == null,
        )
      )
        pendingNonce = 8
    }
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "Pending nonce changed",
    )
    expect(mocked.calls.send).toBe(0)
    const resumable = deps.saved().at(-1)
    expect(resumable?.steps).toEqual([])

    const completed = await executeSquidFunding(
      input(),
      dependencies(mocked, resumable),
    )
    expect(mocked.calls.send).toBe(1)
    expect(completed.steps.find((step) => step.kind === "route")).toEqual(
      expect.objectContaining({ nonce: 8 }),
    )
  })

  it("rejects pre-existing pending transactions before preparing a send", async () => {
    const mocked = clients({ allowance: 10n })
    let balanceReads = 0
    mocked.source.getTransactionCount = async ({ blockTag }) =>
      blockTag === "latest" ? 7 : 8
    mocked.source.getBalance = async () => {
      balanceReads += 1
      return 1_000n
    }
    const deps = dependencies(mocked)
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "account has pending transactions",
    )
    expect(mocked.calls.estimateGas).toBe(0)
    expect(balanceReads).toBe(0)
    expect(deps.saved()).toEqual([])
    expect(mocked.calls.send).toBe(0)
  })

  it("checks the wallet chain after the final pending-nonce read", async () => {
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 10n],
    })
    let nonceReads = 0
    mocked.source.getTransactionCount = async () => {
      nonceReads += 1
      if (nonceReads === 3) {
        await Promise.resolve()
        mocked.setWalletChainId(10)
      }
      return 7
    }
    const deps = dependencies(mocked)
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "Wallet chain",
    )
    expect(nonceReads).toBe(3)
    expect(mocked.calls.send).toBe(0)
    expect(deps.saved().at(-1)?.steps).toEqual([])
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

  it("rejects a successful route spliced from an older checkpoint", async () => {
    const mocked = clients({
      destinationBalances: [0n, 10n, 10n, 20n],
    })
    const older = await executeSquidFunding(input(), dependencies(mocked))
    const current = await executeSquidFunding(input(), dependencies(mocked))
    const olderRoute = older.steps.find((step) => step.kind === "route")
    expect(olderRoute).toBeDefined()
    const forged = {
      ...current,
      steps: current.steps.map((step) =>
        step.kind === "route" ? (olderRoute as SquidExecutionStep) : step,
      ),
    }
    const sends = mocked.calls.send
    const statusCalls = mocked.calls.status
    const transactionReads = mocked.calls.getTransaction
    let rpcCalls = 0
    mocked.source.getChainId = async () => {
      rpcCalls += 1
      return 1
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked, forged)),
    ).rejects.toThrow("Checkpoint integrity verification failed")
    expect(rpcCalls).toBe(0)
    expect(mocked.calls.getTransaction).toBe(transactionReads)
    expect(mocked.calls.status).toBe(statusCalls)
    expect(mocked.calls.send).toBe(sends)
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
    const firstMocked = clients({
      destinationBalances: [0n, 10n, 10n, 20n, 20n, 20n, 30n],
    })
    const first = await executeSquidFunding(
      { ...input([planned, second]), maxSourceAmount: 20n },
      dependencies(firstMocked),
    )
    const checkpoint = reseal({
      ...first,
      steps: first.steps.filter(
        (step) => !(step.kind === "route" && step.requirementId === "fund-2"),
      ),
    })
    firstMocked.source.getBalance = async () => 16n
    const sends = firstMocked.calls.send
    await executeSquidFunding(
      { ...input([planned, second]), maxSourceAmount: 20n },
      dependencies(firstMocked, checkpoint),
    )
    expect(firstMocked.calls.send).toBe(sends + 1)
  })

  it("resumes known transactions without resubmitting them", async () => {
    const mocked = clients()
    const deps = dependencies(mocked)
    const checkpoint = await executeSquidFunding(input(), deps)
    expect(checkpoint.integrity).toMatch(/^0x[0-9a-f]{64}$/)
    expect(deps.saved()).not.toHaveLength(0)
    for (const saved of deps.saved())
      expect(saved.integrity).toMatch(/^0x[0-9a-f]{64}$/)
    const sends = mocked.calls.send
    const resumed = await executeSquidFunding(
      input(),
      dependencies(mocked, checkpoint),
    )
    expect(resumed).toEqual(checkpoint)
    expect(mocked.calls.send).toBe(sends)
    expect(mocked.calls.status).toBe(2)
  })

  it("reconciles pending hashes before checking balance for a later send", async () => {
    const first = quote()
    const second = quote({
      requirement: { ...first.requirement, id: "fund-2" },
    })
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 10n, 10n, 10n],
    })
    const initial = dependencies(mocked)
    let refreshes = 0
    initial.refreshQuote = async (planned) => {
      refreshes += 1
      return refreshes === 1
        ? { ...planned, id: "first-route" }
        : { ...planned, target: spender }
    }
    await expect(
      executeSquidFunding(
        { ...input([first, second]), maxSourceAmount: 20n },
        initial,
      ),
    ).rejects.toThrow("trust checks")
    const completed = initial.saved().at(-1)
    expect(completed).toBeDefined()
    const pending = reseal({
      ...(completed as SquidExecutionCheckpoint),
      steps: (completed as SquidExecutionCheckpoint).steps.map((step) => ({
        ...step,
        receiptStatus: undefined,
      })),
    })
    let sourceBalance = 100n
    const readContract = mocked.source.readContract.bind(mocked.source)
    mocked.source.readContract = async (request: { functionName: string }) =>
      request.functionName === "balanceOf"
        ? sourceBalance
        : readContract(request as never)
    const waitForReceipt = mocked.source.waitForTransactionReceipt.bind(
      mocked.source,
    )
    mocked.source.waitForTransactionReceipt = async (request) => {
      const receipt = await waitForReceipt(request)
      sourceBalance = 5n
      return receipt
    }
    const sends = mocked.calls.send
    await expect(
      executeSquidFunding(
        { ...input([first, second]), maxSourceAmount: 20n },
        dependencies(mocked, pending),
      ),
    ).rejects.toThrow("Source-token balance")
    expect(mocked.calls.send).toBe(sends)
  })

  it("re-approves a revoked allowance without dropping prior fee history", async () => {
    const mocked = clients({ destinationBalances: [0n, 0n, 0n, 10n] })
    const initial = dependencies(mocked)
    let refreshes = 0
    initial.refreshQuote = async (planned) => {
      refreshes += 1
      return refreshes === 1
        ? { ...planned, id: "before-approval" }
        : { ...planned, target: spender }
    }
    await expect(executeSquidFunding(input(), initial)).rejects.toThrow(
      "trust checks",
    )
    const approvalCheckpoint = initial.saved().at(-1)
    expect(approvalCheckpoint).toBeDefined()
    expect(
      (approvalCheckpoint as SquidExecutionCheckpoint).steps.map(
        (step) => step.attempt,
      ),
    ).toEqual([0])
    mocked.setAllowance(0n)
    const sends = mocked.calls.send
    await expect(
      executeSquidFunding(
        { ...input(), maxNativeFee: 11n },
        dependencies(mocked, approvalCheckpoint as SquidExecutionCheckpoint),
      ),
    ).rejects.toThrow("total-native-fee cap")
    expect(mocked.calls.send).toBe(sends)

    const completed = await executeSquidFunding(
      input(),
      dependencies(mocked, approvalCheckpoint as SquidExecutionCheckpoint),
    )
    expect(
      completed.steps
        .filter((step) => step.kind === "approval")
        .map((step) => step.attempt),
    ).toEqual([0, 1])
    expect(
      completed.steps.reduce((total, step) => total + step.nativeFee, 0n),
    ).toBe(18n)
    const sendsAfterCompletion = mocked.calls.send
    await executeSquidFunding(input(), dependencies(mocked, completed))
    expect(mocked.calls.send).toBe(sendsAfterCompletion)
  })

  it("preserves reset and approval history after a reduced allowance", async () => {
    const mocked = clients({ destinationBalances: [0n, 0n, 10n] })
    const initial = dependencies(mocked)
    let refreshes = 0
    initial.refreshQuote = async (planned) => {
      refreshes += 1
      return refreshes === 1
        ? { ...planned, id: "before-approval" }
        : { ...planned, target: spender }
    }
    await expect(executeSquidFunding(input(), initial)).rejects.toThrow(
      "trust checks",
    )
    const approvalCheckpoint = initial.saved().at(-1)
    expect(approvalCheckpoint).toBeDefined()
    mocked.setAllowance(5n)

    const completed = await executeSquidFunding(
      { ...input(), maxNativeFee: 30n },
      dependencies(mocked, approvalCheckpoint as SquidExecutionCheckpoint),
    )
    expect(completed.steps.map((step) => [step.kind, step.attempt])).toEqual([
      ["approval", 0],
      ["approval-reset", 1],
      ["approval", 1],
      ["route", 0],
    ])
    expect(
      completed.steps.reduce((total, step) => total + step.nativeFee, 0n),
    ).toBe(24n)
    const sends = mocked.calls.send
    await executeSquidFunding(
      { ...input(), maxNativeFee: 30n },
      dependencies(mocked, completed),
    )
    expect(mocked.calls.send).toBe(sends)
  })

  it("continues after a reset-only retry and another nonzero allowance", async () => {
    const mocked = clients({
      destinationBalances: [0n, 0n, 0n, 10n],
    })
    const resetOnly = await resetOnlyRetryCheckpoint(mocked)
    mocked.setAllowance(5n)

    const completed = await executeSquidFunding(
      { ...input(), maxNativeFee: 40n },
      dependencies(mocked, resetOnly),
    )
    expect(completed.steps.map((step) => [step.kind, step.attempt])).toEqual([
      ["approval", 0],
      ["approval-reset", 1],
      ["approval-reset", 2],
      ["approval", 2],
      ["route", 0],
    ])
    expect(
      completed.steps.reduce((total, step) => total + step.nativeFee, 0n),
    ).toBe(30n)
    const sends = mocked.calls.send
    await executeSquidFunding(
      { ...input(), maxNativeFee: 40n },
      dependencies(mocked, completed),
    )
    expect(mocked.calls.send).toBe(sends)
  })

  it("continues when an exact allowance appears after a reset-only retry", async () => {
    const mocked = clients({
      destinationBalances: [0n, 0n, 0n, 10n],
    })
    const resetOnly = await resetOnlyRetryCheckpoint(mocked)
    mocked.setAllowance(10n)

    const completed = await executeSquidFunding(
      { ...input(), maxNativeFee: 40n },
      dependencies(mocked, resetOnly),
    )
    expect(completed.steps.map((step) => [step.kind, step.attempt])).toEqual([
      ["approval", 0],
      ["approval-reset", 1],
      ["route", 0],
    ])
    expect(
      completed.steps.reduce((total, step) => total + step.nativeFee, 0n),
    ).toBe(18n)
    const sends = mocked.calls.send
    await executeSquidFunding(
      { ...input(), maxNativeFee: 40n },
      dependencies(mocked, completed),
    )
    expect(mocked.calls.send).toBe(sends)
  })

  it("verifies every resumed hash against its complete saved intent", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const original = mocked.source.getTransaction.bind(mocked.source)
    const routeHash = checkpoint.steps.find(
      (step) => step.kind === "route",
    )?.transactionHash
    mocked.source.getTransaction = async (request: { hash: typeof hash }) => {
      const transaction = await original(request)
      return request.hash === routeHash && transaction != null
        ? { ...transaction, maxPriorityFeePerGas: 0n }
        : transaction
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked, checkpoint)),
    ).rejects.toThrow("saved intent")
  })

  it("ignores a derived gasPrice when verifying an EIP-1559 transaction", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    const original = mocked.source.getTransaction.bind(mocked.source)
    mocked.source.getTransaction = async (request: { hash: typeof hash }) => {
      const transaction = await original(request)
      return transaction == null
        ? transaction
        : { ...transaction, gasPrice: 2n }
    }
    await executeSquidFunding(input(), dependencies(mocked, checkpoint))
    expect(mocked.calls.send).toBe(sends)
  })

  it("requires an exact gasPrice and no EIP-1559 fields for legacy intent", async () => {
    const mocked = clients()
    mocked.source.estimateFeesPerGas = async () => ({ gasPrice: 3n })
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    await executeSquidFunding(input(), dependencies(mocked, checkpoint))
    expect(mocked.calls.send).toBe(sends)

    const original = mocked.source.getTransaction.bind(mocked.source)
    mocked.source.getTransaction = async (request: { hash: typeof hash }) => {
      const transaction = await original(request)
      return transaction == null
        ? transaction
        : { ...transaction, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }
    }
    await expect(
      executeSquidFunding(input(), dependencies(mocked, checkpoint)),
    ).rejects.toThrow("saved intent")
  })

  it("passes a configured local account through without address discovery", async () => {
    const localAccount = { address: account } as Account
    const mocked = clients({
      walletAccount: localAccount,
      getAddressesError: new Error("address discovery should not run"),
    })
    await executeSquidFunding(input(), dependencies(mocked))
    expect(mocked.calls.getAddresses).toBe(0)
    expect(mocked.calls.sent[0]).toEqual(
      expect.objectContaining({ account: localAccount }),
    )
  })

  it("rejects the wrong local account or wallet chain before broadcasting", async () => {
    const wrongAccount = clients({
      walletAccount: { address: thirdParty } as Account,
    })
    await expect(
      executeSquidFunding(input(), dependencies(wrongAccount)),
    ).rejects.toThrow("does not control")
    expect(wrongAccount.calls.send).toBe(0)

    const wrongChain = clients({ walletChainId: 10 })
    await expect(
      executeSquidFunding(input(), dependencies(wrongChain)),
    ).rejects.toThrow("Wallet chain")
    expect(wrongChain.calls.send).toBe(0)
  })

  it("rejects negative floors and nonpositive quote amounts", async () => {
    const negativeSourceFloor = clients()
    await expect(
      executeSquidFunding(
        { ...input(), sourceBalanceFloor: -1n },
        dependencies(negativeSourceFloor),
      ),
    ).rejects.toThrow("Execution limits")
    expect(negativeSourceFloor.calls.send).toBe(0)

    const negativeNativeFloor = clients()
    await expect(
      executeSquidFunding(
        { ...input(), nativeBalanceFloor: -1n },
        dependencies(negativeNativeFloor),
      ),
    ).rejects.toThrow("Execution limits")
    expect(negativeNativeFloor.calls.send).toBe(0)

    const zeroSource = clients()
    await expect(
      executeSquidFunding(
        input([quote({ sourceAmount: 0n })]),
        dependencies(zeroSource),
      ),
    ).rejects.toThrow("Execution limits")
    expect(zeroSource.calls.send).toBe(0)

    const zeroRequirement = clients()
    await expect(
      executeSquidFunding(
        input([
          quote({
            requirement: { ...quote().requirement, amount: 0n },
          }),
        ]),
        dependencies(zeroRequirement),
      ),
    ).rejects.toThrow("Execution limits")
    expect(zeroRequirement.calls.send).toBe(0)
  })

  it("rejects duplicate hashes and malformed checkpoint step shapes", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const duplicateHash = reseal({
      ...checkpoint,
      steps: checkpoint.steps.map((step) => ({
        ...step,
        transactionHash: hash,
      })),
    })
    await expect(
      executeSquidFunding(input(), dependencies(mocked, duplicateHash)),
    ).rejects.toThrow("invalid execution steps")

    const unknownField = reseal({
      ...checkpoint,
      steps: checkpoint.steps.map((step, index) =>
        index === 0 ? { ...step, unexpected: true } : step,
      ),
    } as unknown as SquidExecutionCheckpoint)
    await expect(
      executeSquidFunding(input(), dependencies(mocked, unknownField)),
    ).rejects.toThrow("invalid execution steps")

    const unknownCheckpointField = reseal({
      ...checkpoint,
      unexpected: true,
    } as unknown as SquidExecutionCheckpoint)
    await expect(
      executeSquidFunding(
        input(),
        dependencies(mocked, unknownCheckpointField),
      ),
    ).rejects.toThrow("does not match this execution")

    const incompleteFees = reseal({
      ...checkpoint,
      steps: checkpoint.steps.map((step, index) =>
        index === 0 ? { ...step, maxPriorityFeePerGas: undefined } : step,
      ),
    })
    await expect(
      executeSquidFunding(input(), dependencies(mocked, incompleteFees)),
    ).rejects.toThrow("invalid execution steps")

    const malformedHash = reseal({
      ...checkpoint,
      steps: checkpoint.steps.map((step, index) =>
        index === 0 ? { ...step, transactionHash: 42 } : step,
      ),
    } as unknown as SquidExecutionCheckpoint)
    await expect(
      executeSquidFunding(input(), dependencies(mocked, malformedHash)),
    ).rejects.toThrow("invalid execution steps")

    const noncontiguousAttempt = reseal({
      ...checkpoint,
      steps: checkpoint.steps.map((step) =>
        step.kind === "approval" ? { ...step, attempt: 2 } : step,
      ),
    })
    await expect(
      executeSquidFunding(input(), dependencies(mocked, noncontiguousAttempt)),
    ).rejects.toThrow("invalid execution steps")
  })

  it("rejects checkpoint route minimums below the bound requirement", async () => {
    const mocked = clients({ allowance: 10n })
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    const sends = mocked.calls.send
    const statusCalls = mocked.calls.status
    for (const destinationMinimum of [0n, 9n]) {
      const invalid = reseal({
        ...checkpoint,
        steps: checkpoint.steps.map((step) =>
          step.kind === "route" ? { ...step, destinationMinimum } : step,
        ),
      })
      await expect(
        executeSquidFunding(input(), dependencies(mocked, invalid)),
      ).rejects.toThrow("invalid execution steps")
    }
    expect(mocked.calls.status).toBe(statusCalls)
    expect(mocked.calls.send).toBe(sends)
  })

  it("rejects checkpoint steps that tamper with bound execution context", async () => {
    const cases: Array<{
      name: string
      kind: SquidExecutionStep["kind"]
      step: Partial<SquidExecutionStep>
      transaction?: Record<string, unknown>
      allowance?: bigint
    }> = [
      {
        name: "route sender",
        kind: "route",
        step: { from: thirdParty },
        transaction: { from: thirdParty },
      },
      {
        name: "approval sender",
        kind: "approval",
        step: { from: thirdParty },
        transaction: { from: thirdParty },
      },
      {
        name: "approval-reset sender",
        kind: "approval-reset",
        step: { from: thirdParty },
        transaction: { from: thirdParty },
        allowance: 20n,
      },
      {
        name: "route destination",
        kind: "route",
        step: { to: thirdParty },
        transaction: { to: thirdParty },
      },
      {
        name: "approval destination",
        kind: "approval",
        step: { to: thirdParty },
        transaction: { to: thirdParty },
      },
      {
        name: "approval-reset destination",
        kind: "approval-reset",
        step: { to: thirdParty },
        transaction: { to: thirdParty },
        allowance: 20n,
      },
      {
        name: "source chain",
        kind: "route",
        step: { fromChainId: 2 },
      },
      {
        name: "destination chain",
        kind: "route",
        step: { toChainId: 11 },
      },
    ]
    for (const { name, kind, step, transaction, allowance } of cases) {
      const mocked = allowance == null ? clients() : clients({ allowance })
      const checkpoint = await executeSquidFunding(
        input(),
        dependencies(mocked),
      )
      const invalid = reseal({
        ...checkpoint,
        steps: checkpoint.steps.map((item) =>
          item.kind === kind ? { ...item, ...step } : item,
        ),
      } as SquidExecutionCheckpoint)
      const changed = invalid.steps.find((item) => item.kind === kind)
      if (transaction != null && changed?.transactionHash != null)
        mocked.setTransactionFields(changed.transactionHash, transaction)
      const sends = mocked.calls.send
      const statusCalls = mocked.calls.status
      const transactionReads = mocked.calls.getTransaction
      await expect(
        executeSquidFunding(input(), dependencies(mocked, invalid)),
        name,
      ).rejects.toThrow("invalid execution steps")
      expect(mocked.calls.getTransaction, name).toBe(transactionReads)
      expect(mocked.calls.status, name).toBe(statusCalls)
      expect(mocked.calls.send, name).toBe(sends)
    }
  })

  it("binds requirement amounts and fee mode to the checkpoint identity", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(input(), dependencies(mocked))
    expect(JSON.parse(checkpoint.executionId)).toEqual(
      expect.objectContaining({
        source: [1, sourceToken, false],
        feeMode: "standard",
        quotes: [["fund", "10", "10", 10, destinationToken, account]],
      }),
    )
    const changedAmount = quote({
      requirement: { ...quote().requirement, amount: 11n },
    })
    await expect(
      executeSquidFunding(
        { ...input([changedAmount]), maxSourceAmount: 11n },
        dependencies(mocked, checkpoint),
      ),
    ).rejects.toThrow("does not match this execution")
    await expect(
      executeSquidFunding(
        {
          ...input(),
          feeMode: "op-stack",
          opStackFeeBuffer: (fee) => fee,
        },
        dependencies(mocked, checkpoint),
      ),
    ).rejects.toThrow("does not match this execution")
  })

  it("rejects a valid checkpoint from a different operation before RPC", async () => {
    const mocked = clients()
    const checkpoint = await executeSquidFunding(
      { ...input(), operationId: "operation-a" },
      dependencies(mocked),
    )
    expect(JSON.parse(checkpoint.executionId)).toEqual(
      expect.objectContaining({ operationId: "operation-a" }),
    )
    const sends = mocked.calls.send
    const statusCalls = mocked.calls.status
    const transactionReads = mocked.calls.getTransaction
    let rpcCalls = 0
    mocked.source.getChainId = async () => {
      rpcCalls += 1
      return 1
    }
    await expect(
      executeSquidFunding(
        { ...input(), operationId: "operation-b" },
        dependencies(mocked, checkpoint),
      ),
    ).rejects.toThrow("does not match this execution")
    expect(rpcCalls).toBe(0)
    expect(mocked.calls.getTransaction).toBe(transactionReads)
    expect(mocked.calls.status).toBe(statusCalls)
    expect(mocked.calls.send).toBe(sends)
  })

  it("requires the native flag to match the source token sentinel", async () => {
    const mocked = clients()
    await expect(
      executeSquidFunding(
        input([
          quote({
            source: { ...quote().source, native: true },
          }),
        ]),
        dependencies(mocked),
      ),
    ).rejects.toThrow("source identity")
    expect(mocked.calls.send).toBe(0)
  })

  it("reports a freshly submitted transaction that reverts", async () => {
    const mocked = clients({ allowance: 10n })
    mocked.source.waitForTransactionReceipt = async () => ({
      status: "reverted",
    })
    await expect(
      executeSquidFunding(input(), dependencies(mocked)),
    ).rejects.toThrow("Transaction reverted")
    expect(mocked.calls.send).toBe(1)
  })

  it("reports a saved pending transaction that resumes to reverted", async () => {
    const mocked = clients({ allowance: 10n })
    const completed = await executeSquidFunding(input(), dependencies(mocked))
    const pending = reseal({
      ...completed,
      steps: completed.steps.map((step) => ({
        ...step,
        receiptStatus: undefined,
      })),
    })
    mocked.source.waitForTransactionReceipt = async () => ({
      status: "reverted",
    })
    const sends = mocked.calls.send
    await expect(
      executeSquidFunding(input(), dependencies(mocked, pending)),
    ).rejects.toThrow("Resumed transaction reverted")
    expect(mocked.calls.send).toBe(sends)
  })

  it("bounds pending status polling and reports exhaustion", async () => {
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 0n],
    })
    const deps = dependencies(mocked)
    const waits: number[] = []
    deps.status = async () => {
      mocked.calls.status += 1
      return "pending"
    }
    deps.sleep = async (milliseconds) => {
      waits.push(milliseconds)
    }
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "poll limit",
    )
    expect(mocked.calls.status).toBe(2)
    expect(waits).toEqual([1])
    expect(mocked.calls.send).toBe(1)
  })

  it("uses Squid status options when no status callback is supplied", async () => {
    const mocked = clients({ allowance: 10n })
    const requests: string[] = []
    const fetch = (async (url, init) => {
      requests.push(String(url))
      expect(new Headers(init?.headers).get("x-integrator-id")).toBe("test")
      return new Response(JSON.stringify({ squidTransactionStatus: "SUCCESS" }))
    }) as typeof globalThis.fetch
    await executeSquidFunding(input(), {
      ...dependencies(mocked),
      status: undefined,
      squidStatusOptions: {
        integratorId: "test",
        baseUrl: "https://example.test/v2",
        fetch,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("https://example.test/v2/status?")
    expect(requests[0]).toContain("quoteId=fresh")
  })

  it("requires status wiring before provider or RPC activity", async () => {
    const mocked = clients()
    let rpcCalls = 0
    let refreshes = 0
    mocked.source.getChainId = async () => {
      rpcCalls += 1
      return 1
    }
    await expect(
      executeSquidFunding(input(), {
        ...dependencies(mocked),
        status: undefined,
        squidStatusOptions: undefined,
        refreshQuote: async (planned) => {
          refreshes += 1
          return planned
        },
      }),
    ).rejects.toThrow("status options or a status callback")
    expect(rpcCalls).toBe(0)
    expect(refreshes).toBe(0)
    expect(mocked.calls.getAddresses).toBe(0)
    expect(mocked.calls.send).toBe(0)
  })

  it("rejects malformed status wiring before provider or RPC activity", async () => {
    const cases: Array<
      [string, { status: unknown; squidStatusOptions: unknown }, string]
    > = [
      [
        "non-callable callback",
        {
          status: "success",
          squidStatusOptions: { integratorId: "test", fetch: async () => {} },
        },
        "status callback",
      ],
      [
        "non-object options",
        { status: undefined, squidStatusOptions: "test" },
        "status options",
      ],
      [
        "non-string integrator ID",
        { status: undefined, squidStatusOptions: { integratorId: 1 } },
        "status options",
      ],
      [
        "blank integrator ID",
        { status: undefined, squidStatusOptions: { integratorId: " " } },
        "status options",
      ],
      [
        "blank base URL",
        {
          status: undefined,
          squidStatusOptions: { integratorId: "test", baseUrl: " " },
        },
        "status options",
      ],
      [
        "non-string base URL",
        {
          status: undefined,
          squidStatusOptions: { integratorId: "test", baseUrl: 1 },
        },
        "status options",
      ],
      [
        "non-callable fetch",
        {
          status: undefined,
          squidStatusOptions: { integratorId: "test", fetch: "fetch" },
        },
        "status options",
      ],
      [
        "null fetch",
        {
          status: undefined,
          squidStatusOptions: { integratorId: "test", fetch: null },
        },
        "status options",
      ],
    ]
    for (const [name, wiring, message] of cases) {
      const mocked = clients()
      let rpcCalls = 0
      let refreshes = 0
      let providerCalls = 0
      mocked.source.getChainId = async () => {
        rpcCalls += 1
        return 1
      }
      const deps = {
        ...dependencies(mocked),
        status: wiring.status as never,
        squidStatusOptions: wiring.squidStatusOptions as never,
        refreshQuote: async (planned: SquidQuote) => {
          refreshes += 1
          return planned
        },
      }
      const options = deps.squidStatusOptions as { fetch?: unknown } | undefined
      if (options != null && typeof options === "object") {
        if (options.fetch === undefined)
          options.fetch = (() => {
            providerCalls += 1
          }) as never
        else if (typeof options.fetch === "function") {
          const configuredFetch = options.fetch
          options.fetch = ((...args: unknown[]) => {
            providerCalls += 1
            return configuredFetch(...args)
          }) as never
        }
      }
      await expect(executeSquidFunding(input(), deps), name).rejects.toThrow(
        message,
      )
      expect(rpcCalls, name).toBe(0)
      expect(refreshes, name).toBe(0)
      expect(providerCalls, name).toBe(0)
      expect(mocked.calls.getAddresses, name).toBe(0)
      expect(mocked.calls.send, name).toBe(0)
    }
  })

  it("prefers a callable status callback over malformed built-in options", async () => {
    const mocked = clients({ allowance: 10n })
    await executeSquidFunding(input(), {
      ...dependencies(mocked),
      squidStatusOptions: { integratorId: " " },
    })
    expect(mocked.calls.status).toBe(1)
    expect(mocked.calls.send).toBe(1)
  })

  it("retains ambiguous send failures for manual reconciliation", async () => {
    const mocked = clients({ allowance: 10n })
    let submissions = 0
    mocked.wallet.sendTransaction = async () => {
      submissions += 1
      throw new Error("wallet submission failed")
    }
    const deps = dependencies(mocked)
    await expect(executeSquidFunding(input(), deps)).rejects.toThrow(
      "wallet submission failed",
    )
    expect(submissions).toBe(1)
    const unresolved = deps.saved().at(-1)
    expect(unresolved?.steps).toHaveLength(1)
    expect(unresolved?.steps[0]).toEqual(
      expect.objectContaining({ kind: "route" }),
    )
    expect(unresolved?.steps[0]).not.toHaveProperty("transactionHash")
    await expect(
      executeSquidFunding(input(), dependencies(mocked, unresolved)),
    ).rejects.toThrow("reconcile manually")
    expect(submissions).toBe(1)
  })

  it("waits the configured interval between bounded poll attempts", async () => {
    const mocked = clients({
      allowance: 10n,
      destinationBalances: [0n, 0n, 10n],
    })
    const deps = dependencies(mocked)
    const waits: number[] = []
    let statusChecks = 0
    deps.status = async () => {
      statusChecks += 1
      return statusChecks === 1 ? "pending" : "success"
    }
    deps.sleep = async (milliseconds) => {
      waits.push(milliseconds)
    }
    await executeSquidFunding({ ...input(), pollIntervalMs: 25 }, deps)
    expect(waits).toEqual([25])

    await expect(
      executeSquidFunding(
        { ...input(), pollIntervalMs: 0 },
        dependencies(clients()),
      ),
    ).rejects.toThrow("Execution limits")
    await expect(
      executeSquidFunding(
        { ...input(), pollIntervalMs: Number.MAX_SAFE_INTEGER },
        dependencies(clients()),
      ),
    ).rejects.toThrow("Execution limits")
  })
})
