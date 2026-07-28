import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hash,
  type Hex,
} from "viem"
import { fetchSquidStatus } from "./squid.js"
import type {
  SquidClientOptions,
  SquidExecutionCheckpoint,
  SquidExecutionStep,
  SquidPublicClient,
  SquidQuote,
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
  gasPrice?: bigint
}

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase()
}

function native(token: Address) {
  return sameAddress(token, NATIVE_TOKEN_ADDRESS)
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
}) {
  return [
    input.account.toLowerCase(),
    input.source.chain.chainId,
    input.source.token.toLowerCase(),
    input.trustedTarget.toLowerCase(),
    input.trustedSpender.toLowerCase(),
    ...input.quotes.map((quote) =>
      [
        quote.requirement.id,
        quote.sourceAmount,
        quote.requirement.chainId,
        quote.requirement.token.toLowerCase(),
        quote.requirement.recipient.toLowerCase(),
      ].join(":"),
    ),
  ].join("|")
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
) {
  if (checkpoint.executionId !== expectedId)
    throw new Error("Checkpoint does not match this execution")
  const seen = new Set<string>()
  for (const item of checkpoint.steps) {
    const itemKey = key(item.kind, item.requirementId)
    if (
      seen.has(itemKey) ||
      !requirementIds.has(item.requirementId) ||
      typeof item.nativeFee !== "bigint" ||
      item.nativeFee < 0n ||
      (item.receiptStatus != null && item.transactionHash == null) ||
      (item.kind === "route" &&
        (typeof item.destinationMinimum !== "bigint" ||
          item.destinationMinimum < 0n)) ||
      (item.kind !== "route" && item.destinationMinimum != null)
    )
      throw new Error("Checkpoint has invalid execution steps")
    seen.add(itemKey)
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
    refreshed.requirement.chainId !== planned.requirement.chainId ||
    !sameAddress(refreshed.requirement.token, planned.requirement.token) ||
    !sameAddress(refreshed.requirement.recipient, account) ||
    refreshed.destinationAmount < planned.requirement.amount ||
    !sameAddress(refreshed.target, target) ||
    (refreshed.approvalSpender != null &&
      !sameAddress(refreshed.approvalSpender, spender)) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(refreshed.data) ||
    refreshed.expiresAt <= now ||
    (refreshed.source.native && refreshed.value !== refreshed.sourceAmount) ||
    (!refreshed.source.native && refreshed.value !== 0n)
  )
    throw new Error("Refreshed Squid route failed execution trust checks")
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
  opStack: boolean,
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
  const perGas = fees.maxFeePerGas ?? fees.gasPrice
  if (perGas == null) throw new Error("Complete execution fee is unavailable")
  const feeFields =
    fees.maxFeePerGas == null ? { gasPrice: perGas } : { maxFeePerGas: perGas }
  const request = { ...base, gas, ...feeFields }
  if (!opStack) return { fee: gas * perGas, request }
  if (client.estimateTotalFee == null || buffer == null)
    throw new Error("OP Stack total-fee accounting and buffer are required")
  const total = await client.estimateTotalFee({ account, ...base })
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
    opStack?: boolean
    opStackFeeBuffer?: (totalFee: bigint) => bigint
    maxPollAttempts: number
  },
  dependencies: {
    publicClient: SquidPublicClient
    walletClient: SquidWalletClient
    destinationClient: (chainId: number) => SquidPublicClient
    refreshQuote: (quote: SquidQuote) => Promise<SquidQuote>
    status?: (
      quote: SquidQuote,
      transactionHash: Hash,
    ) => Promise<"pending" | "success" | "failed">
    squidStatusOptions?: SquidClientOptions
    load: () => Promise<SquidExecutionCheckpoint | undefined>
    save: (checkpoint: SquidExecutionCheckpoint) => Promise<void>
    now?: () => number
  },
): Promise<SquidExecutionCheckpoint> {
  if (
    input.quotes.length === 0 ||
    input.maxSourceAmount <= 0n ||
    input.maxNativeFee < 0n ||
    !Number.isSafeInteger(input.maxPollAttempts) ||
    input.maxPollAttempts <= 0
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
    input.quotes.some(
      (quote) =>
        !sameAddress(quote.source.token, input.source.token) ||
        quote.source.chain.chainId !== input.source.chain.chainId,
    )
  )
    throw new Error("All execution quotes must use the supplied source token")
  const sourceAmount = input.quotes.reduce(
    (total, quote) => total + quote.sourceAmount,
    0n,
  )
  if (sourceAmount > input.maxSourceAmount)
    throw new Error("Execution would exceed the source-token cap")
  const id = executionId(input)
  let checkpoint = (await dependencies.load()) ?? { executionId: id, steps: [] }
  assertCheckpoint(checkpoint, id, ids)
  if (checkpoint.steps.some((item) => item.transactionHash == null))
    throw new Error(
      "Checkpoint intent has no transaction hash; reconcile manually before resuming",
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
  let routeNativeValue = 0n
  const now = Math.floor((dependencies.now ?? Date.now)() / 1000)

  const run = async (
    kind: SquidExecutionStep["kind"],
    requirementId: string,
    transaction: Transaction,
    destinationMinimum?: bigint,
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
      input.opStack === true,
      input.opStackFeeBuffer,
    )
    if (totalNativeFee + prepared.fee > input.maxNativeFee)
      throw new Error("Execution would exceed the total-native-fee cap")
    totalNativeFee += prepared.fee
    const nativeUse = input.source.native ? sourceAmount : routeNativeValue
    if (
      nativeBalance <
      (input.nativeBalanceFloor ?? 0n) + nativeUse + totalNativeFee
    )
      throw new Error(
        "Native balance would not cover the source amount and fees",
      )
    const intent: SquidExecutionStep = {
      kind,
      requirementId,
      nativeFee: prepared.fee,
      ...(destinationMinimum == null ? {} : { destinationMinimum }),
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
    const refreshed =
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
      const allowance = await dependencies.publicClient.readContract({
        address: input.source.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.account, input.trustedSpender],
      })
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
    )
    const hash = completed.transactionHash
    if (hash == null || completed.destinationMinimum == null)
      throw new Error("Checkpoint route is incomplete")
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
                { quote: planned, transactionHash: hash },
                dependencies.squidStatusOptions,
              )
          : await dependencies.status(planned, hash)
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
    }
    if (!done)
      throw new Error("Squid route did not complete within the poll limit")
  }
  return checkpoint
}
