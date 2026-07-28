import { createHmac, timingSafeEqual } from "node:crypto"
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
  "attempt",
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

function validStatusOptions(value: unknown): value is SquidClientOptions {
  if (value == null || typeof value !== "object") return false
  const options = value as Record<string, unknown>
  return (
    typeof options.integratorId === "string" &&
    options.integratorId.trim() !== "" &&
    (options.baseUrl === undefined ||
      (typeof options.baseUrl === "string" && options.baseUrl.trim() !== "")) &&
    (options.fetch === undefined
      ? typeof globalThis.fetch === "function"
      : typeof options.fetch === "function")
  )
}

function validIntegrityKey(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number")
    return `{"$number":${JSON.stringify(String(value))}}`
  if (typeof value === "bigint")
    return `{"$bigint":${JSON.stringify(value.toString())}}`
  if (typeof value === "undefined") return '{"$undefined":true}'
  if (typeof value !== "object")
    throw new Error("Checkpoint contains an unsupported value")
  if (seen.has(value)) throw new Error("Checkpoint contains a cycle")
  seen.add(value)
  const encoded = Array.isArray(value)
    ? `[${value.map((item) => canonical(item, seen)).join(",")}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (itemKey) =>
            `${JSON.stringify(itemKey)}:${canonical(
              (value as Record<string, unknown>)[itemKey],
              seen,
            )}`,
        )
        .join(",")}}`
  seen.delete(value)
  return encoded
}

function checkpointPayload(value: unknown): string {
  if (value == null || typeof value !== "object")
    throw new Error("Checkpoint integrity verification failed")
  const checkpoint = value as Record<string, unknown>
  return canonical({
    executionId: checkpoint.executionId,
    steps: checkpoint.steps,
  })
}

function checkpointMac(value: unknown, integrityKey: Hex): Hash {
  return `0x${createHmac("sha256", Buffer.from(integrityKey.slice(2), "hex"))
    .update(checkpointPayload(value))
    .digest("hex")}` as Hash
}

/** Internal checkpoint sealing helper; intentionally not exported from the package root. */
export function sealSquidExecutionCheckpoint(
  checkpoint:
    | SquidExecutionCheckpoint
    | Omit<SquidExecutionCheckpoint, "integrity">,
  integrityKey: Hex,
): SquidExecutionCheckpoint {
  if (!validIntegrityKey(integrityKey))
    throw new Error("A 32-byte checkpoint integrity key is required")
  return {
    ...checkpoint,
    integrity: checkpointMac(checkpoint, integrityKey),
  }
}

function assertCheckpointIntegrity(
  value: unknown,
  integrityKey: Hex,
): asserts value is SquidExecutionCheckpoint {
  const integrity =
    value != null && typeof value === "object"
      ? (value as Record<string, unknown>).integrity
      : undefined
  if (typeof integrity !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(integrity))
    throw new Error("Checkpoint integrity verification failed")
  let expected: Hash
  try {
    expected = checkpointMac(value, integrityKey)
  } catch {
    throw new Error("Checkpoint integrity verification failed")
  }
  const actualBytes = Buffer.from(integrity.slice(2), "hex")
  const expectedBytes = Buffer.from(expected.slice(2), "hex")
  if (!timingSafeEqual(actualBytes, expectedBytes))
    throw new Error("Checkpoint integrity verification failed")
}

function key(
  kind: SquidExecutionStep["kind"],
  requirementId: string,
  attempt: number,
) {
  return `${kind}:${requirementId}:${attempt}`
}

function executionId(input: {
  operationId: string
  account: Address
  source: SquidQuote["source"]
  quotes: readonly SquidQuote[]
  trustedTarget: Address
  trustedSpender: Address
  feeMode: "standard" | "op-stack"
}) {
  return JSON.stringify({
    operationId: input.operationId,
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
  return checkpoint.steps.reduce<SquidExecutionStep | undefined>(
    (latest, item) =>
      item.kind === kind &&
      item.requirementId === requirementId &&
      (latest == null || item.attempt > latest.attempt)
        ? item
        : latest,
    undefined,
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
          key(item.kind, item.requirementId, item.attempt) !==
          key(next.kind, next.requirementId, next.attempt),
      ),
      next,
    ],
  }
}

function assertCheckpoint(
  checkpoint: SquidExecutionCheckpoint,
  expectedId: string,
  context: {
    account: Address
    sourceToken: Address
    sourceChainId: number
    trustedTarget: Address
    requirements: ReadonlyMap<string, { amount: bigint; chainId: number }>
  },
  feeMode: "standard" | "op-stack",
) {
  if (
    checkpoint == null ||
    typeof checkpoint !== "object" ||
    !Array.isArray(checkpoint.steps) ||
    Object.keys(checkpoint).some(
      (checkpointKey) =>
        checkpointKey !== "executionId" &&
        checkpointKey !== "steps" &&
        checkpointKey !== "integrity",
    ) ||
    checkpoint.executionId !== expectedId
  )
    throw new Error("Checkpoint does not match this execution")
  if (
    typeof checkpoint.integrity !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.integrity)
  )
    throw new Error("Checkpoint has invalid integrity metadata")
  const seen = new Set<string>()
  const transactionHashes = new Set<string>()
  const approvalAttempts = new Map<string, Set<number>>()
  const resetAttempts = new Map<string, Set<number>>()
  for (const item of checkpoint.steps) {
    if (item == null || typeof item !== "object")
      throw new Error("Checkpoint has invalid execution steps")
    if (
      item.kind !== "approval" &&
      item.kind !== "approval-reset" &&
      item.kind !== "route"
    )
      throw new Error("Checkpoint has invalid execution steps")
    if (
      typeof item.requirementId !== "string" ||
      !Number.isSafeInteger(item.attempt) ||
      item.attempt < 0 ||
      (item.kind === "route" && item.attempt !== 0)
    )
      throw new Error("Checkpoint has invalid execution steps")
    const allowedKeys =
      item.kind === "route" ? ROUTE_STEP_KEYS : APPROVAL_STEP_KEYS
    if (Object.keys(item).some((itemKey) => !allowedKeys.has(itemKey)))
      throw new Error("Checkpoint has invalid execution steps")
    const itemKey = key(item.kind, item.requirementId, item.attempt)
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
    const requirement = context.requirements.get(item.requirementId)
    if (
      seen.has(itemKey) ||
      (transactionHash != null && transactionHashes.has(transactionHash)) ||
      requirement == null ||
      typeof item.nativeFee !== "bigint" ||
      item.nativeFee < 0n ||
      typeof item.from !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(item.from) ||
      !sameAddress(item.from as Address, context.account) ||
      typeof item.to !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(item.to) ||
      !sameAddress(
        item.to as Address,
        item.kind === "route" ? context.trustedTarget : context.sourceToken,
      ) ||
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
          item.destinationMinimum < requirement.amount ||
          typeof item.quoteId !== "string" ||
          item.quoteId === "" ||
          (item.requestId != null &&
            (typeof item.requestId !== "string" || item.requestId === "")) ||
          !Number.isSafeInteger(item.fromChainId) ||
          item.fromChainId !== context.sourceChainId ||
          !Number.isSafeInteger(item.toChainId) ||
          item.toChainId !== requirement.chainId))
    )
      throw new Error("Checkpoint has invalid execution steps")
    seen.add(itemKey)
    if (transactionHash != null) transactionHashes.add(transactionHash)
    if (item.kind !== "route") {
      const attempts =
        item.kind === "approval" ? approvalAttempts : resetAttempts
      const values = attempts.get(item.requirementId) ?? new Set<number>()
      values.add(item.attempt)
      attempts.set(item.requirementId, values)
    }
  }
  for (const requirementId of context.requirements.keys()) {
    const approvals = approvalAttempts.get(requirementId) ?? new Set<number>()
    const resets = resetAttempts.get(requirementId) ?? new Set<number>()
    const combined = new Set([...approvals, ...resets])
    if (combined.size === 0) continue
    const highest = Math.max(...combined)
    for (let attempt = 0; attempt <= highest; attempt += 1) {
      if (!combined.has(attempt))
        throw new Error("Checkpoint has invalid execution steps")
    }
  }
}

function assertQuote(
  planned: SquidQuote,
  refreshed: SquidQuote,
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
    !sameAddress(
      refreshed.requirement.recipient,
      planned.requirement.recipient,
    ) ||
    typeof refreshed.destinationAmount !== "bigint" ||
    refreshed.destinationAmount < planned.requirement.amount ||
    typeof refreshed.gasLimit !== "bigint" ||
    refreshed.gasLimit <= 0n ||
    typeof refreshed.id !== "string" ||
    refreshed.id.trim() === "" ||
    (refreshed.requestId != null &&
      (typeof refreshed.requestId !== "string" ||
        refreshed.requestId.trim() === "")) ||
    !sameAddress(refreshed.target, target) ||
    (planned.approvalSpender != null &&
      (refreshed.approvalSpender == null ||
        !sameAddress(refreshed.approvalSpender, planned.approvalSpender))) ||
    (refreshed.approvalSpender != null &&
      !sameAddress(refreshed.approvalSpender, spender)) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(refreshed.data) ||
    !Number.isSafeInteger(refreshed.expiresAt) ||
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
  const feeMatches =
    step.maxFeePerGas != null
      ? transaction?.maxFeePerGas === step.maxFeePerGas &&
        transaction.maxPriorityFeePerGas === step.maxPriorityFeePerGas
      : transaction?.maxFeePerGas == null &&
        transaction?.maxPriorityFeePerGas == null &&
        transaction?.gasPrice === step.gasPrice
  if (
    transaction == null ||
    transaction.to == null ||
    !sameAddress(transaction.from, step.from) ||
    !sameAddress(transaction.to, step.to) ||
    keccak256(transaction.input) !== step.dataHash ||
    transaction.value !== step.value ||
    transaction.nonce !== step.nonce ||
    transaction.gas !== step.gas ||
    !feeMatches
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
  const [estimatedGas, fees] = await Promise.all([
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
  const gas =
    transaction.gas != null && transaction.gas > estimatedGas
      ? transaction.gas
      : estimatedGas
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
    operationId: string
    checkpointIntegrityKey: Hex
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
  if (typeof input.operationId !== "string" || input.operationId.trim() === "")
    throw new Error("A nonblank operation ID is required")
  if (!validIntegrityKey(input.checkpointIntegrityKey))
    throw new Error("A 32-byte checkpoint integrity key is required")
  if (
    input.quotes.length === 0 ||
    input.maxSourceAmount <= 0n ||
    input.maxNativeFee < 0n ||
    (input.sourceBalanceFloor ?? 0n) < 0n ||
    (input.nativeBalanceFloor ?? 0n) < 0n ||
    input.quotes.some(
      (quote) => quote.sourceAmount <= 0n || quote.requirement.amount <= 0n,
    ) ||
    (input.feeMode !== "standard" && input.feeMode !== "op-stack") ||
    !Number.isSafeInteger(input.maxPollAttempts) ||
    input.maxPollAttempts <= 0 ||
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs <= 0 ||
    input.pollIntervalMs > MAX_POLL_INTERVAL_MS
  )
    throw new Error("Execution limits and at least one quote are required")
  const requirements = new Map(
    input.quotes.map(
      (quote) =>
        [
          quote.requirement.id,
          {
            amount: quote.requirement.amount,
            chainId: quote.requirement.chainId,
          },
        ] as const,
    ),
  )
  if (requirements.size !== input.quotes.length)
    throw new Error("Execution requirement IDs must be unique")
  const configuredStatus: unknown = dependencies.status
  const configuredStatusOptions: unknown = dependencies.squidStatusOptions
  let status: NonNullable<typeof dependencies.status>
  if (configuredStatus != null) {
    if (typeof configuredStatus !== "function")
      throw new Error("Squid status callback must be callable")
    status = configuredStatus as NonNullable<typeof dependencies.status>
  } else {
    if (configuredStatusOptions == null)
      throw new Error("Squid status options or a status callback are required")
    if (!validStatusOptions(configuredStatusOptions))
      throw new Error("Valid Squid status options are required")
    status = (reference: SquidStatusReference, transactionHash: Hash) =>
      fetchSquidStatus(
        { status: reference, transactionHash },
        configuredStatusOptions,
      )
  }
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
  const loaded = await dependencies.load()
  if (loaded != null)
    assertCheckpointIntegrity(loaded, input.checkpointIntegrityKey)
  let checkpoint =
    loaded ??
    sealSquidExecutionCheckpoint(
      { executionId: id, steps: [] },
      input.checkpointIntegrityKey,
    )
  assertCheckpoint(
    checkpoint,
    id,
    {
      account: input.account,
      sourceToken: input.source.token,
      sourceChainId: input.source.chain.chainId,
      trustedTarget: input.trustedTarget,
      requirements,
    },
    input.feeMode,
  )
  const saveCheckpoint = async (next: SquidExecutionCheckpoint) => {
    const sealed = sealSquidExecutionCheckpoint(
      next,
      input.checkpointIntegrityKey,
    )
    await dependencies.save(sealed)
    return sealed
  }
  if (
    (await dependencies.publicClient.getChainId()) !==
    input.source.chain.chainId
  )
    throw new Error("Source RPC chain does not match the Squid source chain")
  if (
    (await dependencies.walletClient.getChainId()) !==
    input.source.chain.chainId
  )
    throw new Error("Wallet chain does not match the Squid source chain")
  const configuredAccount = dependencies.walletClient.account
  if (
    configuredAccount != null
      ? !sameAddress(configuredAccount.address, input.account)
      : !(await dependencies.walletClient.getAddresses()).some((address) =>
          sameAddress(address, input.account),
        )
  )
    throw new Error("Wallet client does not control the requested account")
  if (checkpoint.steps.some((item) => item.transactionHash == null))
    throw new Error(
      "Checkpoint intent has no transaction hash; reconcile manually before resuming",
    )
  await Promise.all(
    checkpoint.steps.map((step) =>
      assertSubmittedIntent(dependencies.publicClient, step),
    ),
  )
  for (const step of checkpoint.steps) {
    if (step.receiptStatus === "reverted")
      throw new Error("Checkpoint contains a reverted transaction")
    if (step.receiptStatus == null && step.transactionHash != null) {
      const receipt = await dependencies.publicClient.waitForTransactionReceipt(
        { hash: step.transactionHash },
      )
      checkpoint = withStep(checkpoint, {
        ...step,
        receiptStatus: receipt.status,
      })
      checkpoint = await saveCheckpoint(checkpoint)
      if (receipt.status !== "success")
        throw new Error("Resumed transaction reverted")
    }
  }
  let totalNativeFee = checkpoint.steps.reduce(
    (total, item) => total + item.nativeFee,
    0n,
  )
  if (totalNativeFee > input.maxNativeFee)
    throw new Error("Checkpoint exceeds the total-native-fee cap")
  const unsentSource = () =>
    input.quotes.reduce(
      (total, quote) =>
        current(checkpoint, "route", quote.requirement.id) == null
          ? total + quote.sourceAmount
          : total,
      0n,
    )

  const run = async (
    kind: SquidExecutionStep["kind"],
    requirementId: string,
    attempt: number,
    transaction: Transaction,
    destinationMinimum?: bigint,
    statusReference?: SquidStatusReference,
    preSend?: () => void,
  ) => {
    const known = checkpoint.steps.find(
      (step) =>
        step.kind === kind &&
        step.requirementId === requirementId &&
        step.attempt === attempt,
    )
    if (known?.receiptStatus === "success") return known
    if (known != null)
      throw new Error("Checkpoint transaction is not reconciled")
    const [latestNonce, pendingNonce] = await Promise.all([
      dependencies.publicClient.getTransactionCount({
        address: input.account,
        blockTag: "latest",
      }),
      dependencies.publicClient.getTransactionCount({
        address: input.account,
        blockTag: "pending",
      }),
    ])
    if (latestNonce !== pendingNonce)
      throw new Error("Source account has pending transactions")
    const prepared = await prepare(
      dependencies.publicClient,
      { ...transaction, nonce: pendingNonce },
      input.account,
      input.feeMode,
      input.opStackFeeBuffer,
    )
    if (totalNativeFee + prepared.fee > input.maxNativeFee)
      throw new Error("Execution would exceed the total-native-fee cap")
    const [nativeBalance, sourceBalance] = await Promise.all([
      dependencies.publicClient.getBalance({ address: input.account }),
      input.source.native
        ? Promise.resolve(undefined)
        : balance(dependencies.publicClient, input.source.token, input.account),
    ])
    const remainingSource = unsentSource()
    if (input.source.native) {
      const floor =
        (input.sourceBalanceFloor ?? 0n) > (input.nativeBalanceFloor ?? 0n)
          ? (input.sourceBalanceFloor ?? 0n)
          : (input.nativeBalanceFloor ?? 0n)
      if (nativeBalance < floor + remainingSource + prepared.fee)
        throw new Error(
          "Native balance would not cover the source amount, fee, and floor",
        )
    } else {
      if (
        sourceBalance == null ||
        sourceBalance < remainingSource + (input.sourceBalanceFloor ?? 0n)
      )
        throw new Error("Source-token balance would cross its required floor")
      if (nativeBalance < prepared.fee + (input.nativeBalanceFloor ?? 0n))
        throw new Error("Native balance would not cover the fee and floor")
    }
    totalNativeFee += prepared.fee
    const intent: SquidExecutionStep = {
      kind,
      requirementId,
      attempt,
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
    checkpoint = await saveCheckpoint(checkpoint)
    const request = {
      account: configuredAccount ?? input.account,
      chain: undefined,
      ...prepared.request,
    }
    try {
      const currentNonce = await dependencies.publicClient.getTransactionCount({
        address: input.account,
        blockTag: "pending",
      })
      if (currentNonce !== prepared.request.nonce)
        throw new Error("Pending nonce changed before broadcast")
      const walletChainId = await dependencies.walletClient.getChainId()
      if (walletChainId !== input.source.chain.chainId)
        throw new Error("Wallet chain does not match the Squid source chain")
      preSend?.()
    } catch (error) {
      checkpoint = {
        ...checkpoint,
        steps: checkpoint.steps.filter(
          (step) =>
            key(step.kind, step.requirementId, step.attempt) !==
            key(intent.kind, intent.requirementId, intent.attempt),
        ),
      }
      checkpoint = await saveCheckpoint(checkpoint)
      throw error
    }
    const submission = dependencies.walletClient.sendTransaction(
      request as never,
    )
    const transactionHash = (await submission) as Hash
    const sent = { ...intent, transactionHash }
    checkpoint = withStep(checkpoint, sent)
    checkpoint = await saveCheckpoint(checkpoint)
    const receipt = await dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    checkpoint = withStep(checkpoint, {
      ...sent,
      receiptStatus: receipt.status,
    })
    checkpoint = await saveCheckpoint(checkpoint)
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
        input.trustedTarget,
        input.trustedSpender,
        Math.floor((dependencies.now ?? Date.now)() / 1000),
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
      const previousApproval = current(
        checkpoint,
        "approval",
        planned.requirement.id,
      )
      const previousReset = current(
        checkpoint,
        "approval-reset",
        planned.requirement.id,
      )
      let approvalChanged = previousApproval != null || previousReset != null
      if (allowance !== refreshed.sourceAmount) {
        approvalChanged = true
        const approvalAttempt =
          allowance === 0n &&
          previousReset != null &&
          (previousApproval == null ||
            previousReset.attempt > previousApproval.attempt)
            ? previousReset.attempt
            : Math.max(
                previousApproval?.attempt ?? -1,
                previousReset?.attempt ?? -1,
              ) + 1
        if (allowance > 0n)
          await run("approval-reset", planned.requirement.id, approvalAttempt, {
            to: input.source.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [input.trustedSpender, 0n],
            }),
            value: 0n,
            nonce: 0,
          })
        await run("approval", planned.requirement.id, approvalAttempt, {
          to: input.source.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [input.trustedSpender, refreshed.sourceAmount],
          }),
          value: 0n,
          nonce: 0,
        })
      }
      if (approvalChanged) {
        refreshed = await dependencies.refreshQuote(planned)
        assertQuote(
          planned,
          refreshed,
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
    const completed = await run(
      "route",
      planned.requirement.id,
      0,
      {
        to: refreshed.target,
        data: refreshed.data,
        value: refreshed.value,
        nonce: 0,
        gas: refreshed.gasLimit,
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
      route == null
        ? () =>
            assertQuote(
              planned,
              refreshed,
              input.trustedTarget,
              input.trustedSpender,
              Math.floor((dependencies.now ?? Date.now)() / 1000),
            )
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
      const routeStatus = await status(statusReference, hash)
      const after = await balance(
        destinationClient,
        planned.requirement.token,
        planned.requirement.recipient,
      )
      if (routeStatus === "failed") throw new Error("Squid route failed")
      if (routeStatus === "success" && after >= completed.destinationMinimum) {
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
