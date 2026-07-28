import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hash,
  type Hex,
  keccak256,
} from "viem"
import { fetchSquidStatus } from "./squid.js"
import type {
  SquidClientOptions,
  SquidExecutionCheckpoint,
  SquidExecutionStep,
  SquidPublicClient,
  SquidQuote,
  SquidStatusReference,
  SquidWalletClient,
} from "./types.js"
import { NATIVE_TOKEN_ADDRESS } from "./types.js"

type Transaction = {
  to: Address
  data: Hex
  value: bigint
  nonce: number
  gas?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
}

const COMMON_STEP_KEYS = [
  "kind",
  "requirementId",
  "nativeFee",
  "from",
  "to",
  "dataHash",
  "value",
  "nonce",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "gasPrice",
  "transactionHash",
  "receiptStatus",
] as const

const ROUTE_STEP_KEYS = new Set<string>([
  ...COMMON_STEP_KEYS,
  "destinationMinimum",
  "quoteId",
  "requestId",
  "fromChainId",
  "toChainId",
])

const APPROVAL_STEP_KEYS = new Set<string>(COMMON_STEP_KEYS)
const MAX_POLL_INTERVAL_MS = 2_147_483_647

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase()
}

function native(token: Address) {
  return sameAddress(token, NATIVE_TOKEN_ADDRESS)
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function key(kind: SquidExecutionStep["kind"], requirementId: string) {
  return `${kind}:${requirementId}`
}

function executionId(input: {
  account: Address
  source: SquidQuote["source"]
  quotes: readonly SquidQuote[]
  trustedTarget: Address
  trustedSpender: Address
  feeMode: "standard" | "op-stack"
}) {
  return JSON.stringify({
    account: input.account.toLowerCase(),
    source: [
      input.source.chain.chainId,
      input.source.token.toLowerCase(),
      input.source.native,
    ],
    target: input.trustedTarget.toLowerCase(),
    spender: input.trustedSpender.toLowerCase(),
    feeMode: input.feeMode,
    quotes: input.quotes.map((quote) => [
      quote.requirement.id,
      quote.sourceAmount.toString(),
      quote.requirement.amount.toString(),
      quote.requirement.chainId,
      quote.requirement.token.toLowerCase(),
      quote.requirement.recipient.toLowerCase(),
    ]),
  })
}

function current(
  checkpoint: SquidExecutionCheckpoint,
  kind: SquidExecutionStep["kind"],
  requirementId: string,
) {
  return checkpoint.steps.find(
    (item) => item.kind === kind && item.requirementId === requirementId,
  )
}

function withStep(
  checkpoint: SquidExecutionCheckpoint,
  next: SquidExecutionStep,
) {
  return {
    ...checkpoint,
    steps: [
      ...checkpoint.steps.filter(
        (item) =>
          key(item.kind, item.requirementId) !==
          key(next.kind, next.requirementId),
      ),
      next,
    ],
  }
}

function assertCheckpoint(
  checkpoint: SquidExecutionCheckpoint,
  expectedId: string,
  requirementIds: Set<string>,
  feeMode: "standard" | "op-stack",
) {
  if (
    checkpoint == null ||
    typeof checkpoint !== "object" ||
    !Array.isArray(checkpoint.steps) ||
    Object.keys(checkpoint).some(
      (checkpointKey) =>
        checkpointKey !== "executionId" && checkpointKey !== "steps",
    ) ||
    checkpoint.executionId !== expectedId
  )
    throw new Error("Checkpoint does not match this execution")
  const seen = new Set<string>()
  const transactionHashes = new Set<string>()
  for (const item of checkpoint.steps) {
    if (item == null || typeof item !== "object")
      throw new Error("Checkpoint has invalid execution steps")
    if (
      item.kind !== "approval" &&
      item.kind !== "approval-reset" &&
      item.kind !== "route"
    )
      throw new Error("Checkpoint has invalid execution steps")
    if (typeof item.requirementId !== "string")
      throw new Error("Checkpoint has invalid execution steps")
    const allowedKeys =
      item.kind === "route" ? ROUTE_STEP_KEYS : APPROVAL_STEP_KEYS
    if (Object.keys(item).some((itemKey) => !allowedKeys.has(itemKey)))
      throw new Error("Checkpoint has invalid execution steps")
    const itemKey = key(item.kind, item.requirementId)
    const eip1559Fees =
      typeof item.maxFeePerGas === "bigint" &&
      item.maxFeePerGas > 0n &&
      typeof item.maxPriorityFeePerGas === "bigint" &&
      item.maxPriorityFeePerGas >= 0n &&
      item.maxPriorityFeePerGas <= item.maxFeePerGas &&
      item.gasPrice == null
    const legacyFees =
      typeof item.gasPrice === "bigint" &&
      item.gasPrice > 0n &&
      item.maxFeePerGas == null &&
      item.maxPriorityFeePerGas == null
    const transactionHash =
      typeof item.transactionHash === "string"
        ? item.transactionHash.toLowerCase()
        : undefined
    if (
      seen.has(itemKey) ||
      (transactionHash != null && transactionHashes.has(transactionHash)) ||
      !requirementIds.has(item.requirementId) ||
      typeof item.nativeFee !== "bigint" ||
      item.nativeFee < 0n ||
      typeof item.from !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(item.from) ||
      typeof item.to !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(item.to) ||
      typeof item.dataHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(item.dataHash) ||
      typeof item.value !== "bigint" ||
      item.value < 0n ||
      !Number.isSafeInteger(item.nonce) ||
      item.nonce < 0 ||
      typeof item.gas !== "bigint" ||
      item.gas <= 0n ||
      (!eip1559Fees && !legacyFees) ||
      (feeMode === "standard" &&
        item.nativeFee !==
          item.gas *
            (eip1559Fees
              ? (item.maxFeePerGas as bigint)
              : (item.gasPrice as bigint))) ||
      (item.transactionHash != null &&
        (typeof item.transactionHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(item.transactionHash))) ||
      (item.receiptStatus != null &&
        item.receiptStatus !== "success" &&
        item.receiptStatus !== "reverted") ||
      (item.receiptStatus != null && item.transactionHash == null) ||
      (item.kind === "route" &&
        (typeof item.destinationMinimum !== "bigint" ||
          item.destinationMinimum < 0n ||
          typeof item.quoteId !== "string" ||
          item.quoteId === "" ||
          (item.requestId != null &&
            (typeof item.requestId !== "string" || item.requestId === "")) ||
          !Number.isSafeInteger(item.fromChainId) ||
          (item.fromChainId as number) <= 0 ||
          !Number.isSafeInteger(item.toChainId) ||
          (item.toChainId as number) <= 0))
    )
      throw new Error("Checkpoint has invalid execution steps")
    seen.add(itemKey)
    if (transactionHash != null) transactionHashes.add(transactionHash)
  }
}

function assertQuote(
  planned: SquidQuote,
  refreshed: SquidQuote,
  account: Address,
  target: Address,
  spender: Address,
  now: number,
) {
  if (
    refreshed.requirement.id !== planned.requirement.id ||
    refreshed.source.chain.chainId !== planned.source.chain.chainId ||
    !sameAddress(refreshed.source.token, planned.source.token) ||
    refreshed.sourceAmount !== planned.sourceAmount ||
    refreshed.source.native !== planned.source.native ||
    refreshed.requirement.chainId !== planned.requirement.chainId ||
    !sameAddress(refreshed.requirement.token, planned.requirement.token) ||
    !sameAddress(refreshed.requirement.recipient, account) ||
    refreshed.destinationAmount < planned.requirement.amount ||
    !sameAddress(refreshed.target, target) ||
    (planned.approvalSpender != null &&
      (refreshed.approvalSpender == null ||
        !sameAddress(refreshed.approvalSpender, planned.approvalSpender))) ||
    (refreshed.approvalSpender != null &&
      !sameAddress(refreshed.approvalSpender, spender)) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(refreshed.data) ||
    refreshed.expiresAt <= now ||
    (refreshed.source.native && refreshed.value !== refreshed.sourceAmount) ||
    (!refreshed.source.native && refreshed.value !== 0n)
  )
    throw new Error("Refreshed Squid route failed execution trust checks")
}

async function assertSubmittedIntent(
  client: SquidPublicClient,
  step: SquidExecutionStep,
) {
  if (step.transactionHash == null) return
  const transaction = await client.getTransaction({
    hash: step.transactionHash,
  })
  if (
    transaction == null ||
    transaction.to == null ||
    !sameAddress(transaction.from, step.from) ||
    !sameAddress(transaction.to, step.to) ||
    keccak256(transaction.input) !== step.dataHash ||
    transaction.value !== step.value ||
    transaction.nonce !== step.nonce ||
    transaction.gas !== step.gas ||
    transaction.maxFeePerGas !== step.maxFeePerGas ||
    transaction.maxPriorityFeePerGas !== step.maxPriorityFeePerGas ||
    transaction.gasPrice !== step.gasPrice
  )
    throw new Error("Checkpoint transaction does not match its saved intent")
}

async function balance(
  client: SquidPublicClient,
  token: Address,
  owner: Address,
) {
  if (native(token)) return client.getBalance({ address: owner })
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })
}

async function prepare(
  client: SquidPublicClient,
  transaction: Transaction,
  account: Address,
  feeMode: "standard" | "op-stack",
  buffer: ((totalFee: bigint) => bigint) | undefined,
) {
  const base = {
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    nonce: transaction.nonce,
  }
  const [gas, fees] = await Promise.all([
    client.estimateGas({ account, ...base }),
    client.estimateFeesPerGas(),
  ])
  let feeFields:
    | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    | { gasPrice: bigint }
  let perGas: bigint
  if (
    fees.maxFeePerGas != null &&
    fees.maxPriorityFeePerGas != null &&
    fees.maxFeePerGas > 0n &&
    fees.maxPriorityFeePerGas >= 0n &&
    fees.maxPriorityFeePerGas <= fees.maxFeePerGas
  ) {
    feeFields = {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }
    perGas = fees.maxFeePerGas
  } else if (
    fees.maxFeePerGas == null &&
    fees.gasPrice != null &&
    fees.gasPrice > 0n
  ) {
    feeFields = { gasPrice: fees.gasPrice }
    perGas = fees.gasPrice
  } else {
    throw new Error("Complete execution fee is unavailable")
  }
  if (gas <= 0n) throw new Error("Complete execution fee is unavailable")
  const request = { ...base, gas, ...feeFields }
  if (feeMode === "standard") return { fee: gas * perGas, request }
  if (client.estimateTotalFee == null || buffer == null)
    throw new Error("OP Stack total-fee accounting and buffer are required")
  const total = await client.estimateTotalFee({ account, ...request })
  const buffered = buffer(total)
  if (buffered < total)
    throw new Error("OP Stack fee buffer must not reduce the total fee")
  return { fee: buffered, request }
}

export async function executeSquidFunding(
  input: {
    account: Address
    source: SquidQuote["source"]
    quotes: readonly SquidQuote[]
    maxSourceAmount: bigint
    maxNativeFee: bigint
    sourceBalanceFloor?: bigint
    nativeBalanceFloor?: bigint
    trustedTarget: Address
    trustedSpender: Address
    feeMode: "standard" | "op-stack"
    opStackFeeBuffer?: (totalFee: bigint) => bigint
    maxPollAttempts: number
    pollIntervalMs: number
  },
  dependencies: {
    publicClient: SquidPublicClient
    walletClient: SquidWalletClient
    destinationClient: (chainId: number) => SquidPublicClient
    refreshQuote: (quote: SquidQuote) => Promise<SquidQuote>
    status?: (
      status: SquidStatusReference,
      transactionHash: Hash,
    ) => Promise<"pending" | "success" | "failed">
    squidStatusOptions?: SquidClientOptions
    load: () => Promise<SquidExecutionCheckpoint | undefined>
    save: (checkpoint: SquidExecutionCheckpoint) => Promise<void>
    now?: () => number
    sleep?: (milliseconds: number) => Promise<void>
  },
): Promise<SquidExecutionCheckpoint> {
  if (
    input.quotes.length === 0 ||
    input.maxSourceAmount <= 0n ||
    input.maxNativeFee < 0n ||
    (input.feeMode !== "standard" && input.feeMode !== "op-stack") ||
    !Number.isSafeInteger(input.maxPollAttempts) ||
    input.maxPollAttempts <= 0 ||
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs <= 0 ||
    input.pollIntervalMs > MAX_POLL_INTERVAL_MS
  )
    throw new Error("Execution limits and at least one quote are required")
  const ids = new Set(input.quotes.map((quote) => quote.requirement.id))
  if (ids.size !== input.quotes.length)
    throw new Error("Execution requirement IDs must be unique")
  if (
    (await dependencies.publicClient.getChainId()) !==
    input.source.chain.chainId
  )
    throw new Error("Source RPC chain does not match the Squid source chain")
  if (
    !(await dependencies.walletClient.getAddresses()).some((address) =>
      sameAddress(address, input.account),
    )
  )
    throw new Error("Wallet client does not control the requested account")
  if (
    native(input.source.token) !== input.source.native ||
    input.quotes.some(
      (quote) =>
        !sameAddress(quote.source.token, input.source.token) ||
        quote.source.chain.chainId !== input.source.chain.chainId ||
        quote.source.native !== input.source.native ||
        native(quote.source.token) !== quote.source.native,
    )
  )
    throw new Error(
      "All execution quotes must use the supplied source identity",
    )
  const sourceAmount = input.quotes.reduce(
    (total, quote) => total + quote.sourceAmount,
    0n,
  )
  if (sourceAmount > input.maxSourceAmount)
    throw new Error("Execution would exceed the source-token cap")
  const id = executionId(input)
  let checkpoint = (await dependencies.load()) ?? { executionId: id, steps: [] }
  assertCheckpoint(checkpoint, id, ids, input.feeMode)
  if (checkpoint.steps.some((item) => item.transactionHash == null))
    throw new Error(
      "Checkpoint intent has no transaction hash; reconcile manually before resuming",
    )
  await Promise.all(
    checkpoint.steps.map((step) =>
      assertSubmittedIntent(dependencies.publicClient, step),
    ),
  )
  let totalNativeFee = checkpoint.steps.reduce(
    (total, item) => total + item.nativeFee,
    0n,
  )
  if (totalNativeFee > input.maxNativeFee)
    throw new Error("Checkpoint exceeds the total-native-fee cap")
  const unsent = input.quotes.filter(
    (quote) => current(checkpoint, "route", quote.requirement.id) == null,
  )
  const unsentSource = unsent.reduce(
    (total, quote) => total + quote.sourceAmount,
    0n,
  )
  const [sourceBalance, nativeBalance, nonce] = await Promise.all([
    balance(dependencies.publicClient, input.source.token, input.account),
    dependencies.publicClient.getBalance({ address: input.account }),
    dependencies.publicClient.getTransactionCount({
      address: input.account,
      blockTag: "pending",
    }),
  ])
  if (sourceBalance < unsentSource + (input.sourceBalanceFloor ?? 0n))
    throw new Error("Source-token balance would cross its required floor")
  let nextNonce = nonce
  let newNativeFee = 0n
  let routeNativeValue = 0n
  const now = Math.floor((dependencies.now ?? Date.now)() / 1000)

  const run = async (
    kind: SquidExecutionStep["kind"],
    requirementId: string,
    transaction: Transaction,
    destinationMinimum?: bigint,
    statusReference?: SquidStatusReference,
  ) => {
    const known = current(checkpoint, kind, requirementId)
    if (known?.receiptStatus === "success") return known
    if (known?.transactionHash != null) {
      const receipt = await dependencies.publicClient.waitForTransactionReceipt(
        { hash: known.transactionHash },
      )
      checkpoint = withStep(checkpoint, {
        ...known,
        receiptStatus: receipt.status,
      })
      await dependencies.save(checkpoint)
      if (receipt.status !== "success")
        throw new Error("Resumed transaction reverted")
      return current(checkpoint, kind, requirementId) as SquidExecutionStep
    }
    const prepared = await prepare(
      dependencies.publicClient,
      { ...transaction, nonce: nextNonce },
      input.account,
      input.feeMode,
      input.opStackFeeBuffer,
    )
    if (totalNativeFee + prepared.fee > input.maxNativeFee)
      throw new Error("Execution would exceed the total-native-fee cap")
    totalNativeFee += prepared.fee
    newNativeFee += prepared.fee
    const nativeUse = input.source.native ? unsentSource : routeNativeValue
    if (
      nativeBalance <
      (input.nativeBalanceFloor ?? 0n) + nativeUse + newNativeFee
    )
      throw new Error(
        "Native balance would not cover the source amount and fees",
      )
    const intent: SquidExecutionStep = {
      kind,
      requirementId,
      nativeFee: prepared.fee,
      from: input.account,
      to: prepared.request.to,
      dataHash: keccak256(prepared.request.data),
      value: prepared.request.value,
      nonce: prepared.request.nonce,
      gas: prepared.request.gas,
      ...("gasPrice" in prepared.request
        ? { gasPrice: prepared.request.gasPrice }
        : {
            maxFeePerGas: prepared.request.maxFeePerGas,
            maxPriorityFeePerGas: prepared.request.maxPriorityFeePerGas,
          }),
      ...(destinationMinimum == null ? {} : { destinationMinimum }),
      ...(statusReference == null ? {} : statusReference),
    }
    checkpoint = withStep(checkpoint, intent)
    await dependencies.save(checkpoint)
    const transactionHash = (await dependencies.walletClient.sendTransaction({
      account: input.account,
      chain: undefined,
      ...prepared.request,
    } as never)) as Hash
    nextNonce += 1
    const sent = { ...intent, transactionHash }
    checkpoint = withStep(checkpoint, sent)
    await dependencies.save(checkpoint)
    const receipt = await dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    checkpoint = withStep(checkpoint, {
      ...sent,
      receiptStatus: receipt.status,
    })
    await dependencies.save(checkpoint)
    if (receipt.status !== "success") throw new Error("Transaction reverted")
    return current(checkpoint, kind, requirementId) as SquidExecutionStep
  }

  for (const planned of input.quotes) {
    const route = current(checkpoint, "route", planned.requirement.id)
    let refreshed =
      route == null ? await dependencies.refreshQuote(planned) : planned
    if (route == null)
      assertQuote(
        planned,
        refreshed,
        input.account,
        input.trustedTarget,
        input.trustedSpender,
        now,
      )
    const destinationClient = dependencies.destinationClient(
      planned.requirement.chainId,
    )
    if ((await destinationClient.getChainId()) !== planned.requirement.chainId)
      throw new Error("Destination RPC chain does not match the Squid route")
    const before =
      route?.destinationMinimum ??
      (await balance(
        destinationClient,
        planned.requirement.token,
        planned.requirement.recipient,
      )) + planned.requirement.amount
    if (!input.source.native && route == null) {
      let allowance = await dependencies.publicClient.readContract({
        address: input.source.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.account, input.trustedSpender],
      })
      let approvalChanged =
        current(checkpoint, "approval-reset", planned.requirement.id) != null ||
        current(checkpoint, "approval", planned.requirement.id) != null
      if (allowance !== refreshed.sourceAmount && allowance > 0n)
        await run("approval-reset", planned.requirement.id, {
          to: input.source.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [input.trustedSpender, 0n],
          }),
          value: 0n,
          nonce: 0,
        })
      if (allowance !== refreshed.sourceAmount) approvalChanged = true
      if (allowance !== refreshed.sourceAmount)
        await run("approval", planned.requirement.id, {
          to: input.source.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [input.trustedSpender, refreshed.sourceAmount],
          }),
          value: 0n,
          nonce: 0,
        })
      if (approvalChanged) {
        refreshed = await dependencies.refreshQuote(planned)
        assertQuote(
          planned,
          refreshed,
          input.account,
          input.trustedTarget,
          input.trustedSpender,
          Math.floor((dependencies.now ?? Date.now)() / 1000),
        )
        allowance = await dependencies.publicClient.readContract({
          address: input.source.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [input.account, input.trustedSpender],
        })
        if (allowance !== refreshed.sourceAmount)
          throw new Error(
            "Exact source-token allowance is required after approval",
          )
      }
    }
    if (route == null) routeNativeValue += refreshed.value
    const completed = await run(
      "route",
      planned.requirement.id,
      {
        to: refreshed.target,
        data: refreshed.data,
        value: refreshed.value,
        nonce: 0,
      },
      before,
      route == null
        ? {
            quoteId: refreshed.id,
            ...(refreshed.requestId == null
              ? {}
              : { requestId: refreshed.requestId }),
            fromChainId: refreshed.source.chain.chainId,
            toChainId: refreshed.requirement.chainId,
          }
        : undefined,
    )
    const hash = completed.transactionHash
    if (
      hash == null ||
      completed.destinationMinimum == null ||
      completed.quoteId == null ||
      completed.fromChainId == null ||
      completed.toChainId == null
    )
      throw new Error("Checkpoint route is incomplete")
    const statusReference: SquidStatusReference = {
      quoteId: completed.quoteId,
      ...(completed.requestId == null
        ? {}
        : { requestId: completed.requestId }),
      fromChainId: completed.fromChainId,
      toChainId: completed.toChainId,
    }
    let done = false
    for (let attempt = 0; attempt < input.maxPollAttempts; attempt += 1) {
      const status =
        dependencies.status == null
          ? dependencies.squidStatusOptions == null
            ? (() => {
                throw new Error(
                  "Squid status options or a status callback are required",
                )
              })()
            : await fetchSquidStatus(
                { status: statusReference, transactionHash: hash },
                dependencies.squidStatusOptions,
              )
          : await dependencies.status(statusReference, hash)
      const after = await balance(
        destinationClient,
        planned.requirement.token,
        planned.requirement.recipient,
      )
      if (status === "failed") throw new Error("Squid route failed")
      if (status === "success" && after >= completed.destinationMinimum) {
        done = true
        break
      }
      if (attempt + 1 < input.maxPollAttempts)
        await (dependencies.sleep ?? sleep)(input.pollIntervalMs)
    }
    if (!done)
      throw new Error("Squid route did not complete within the poll limit")
  }
  return checkpoint
}
