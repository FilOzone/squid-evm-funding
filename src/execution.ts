import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hash,
  type Hex,
} from "viem"
import type {
  SquidExecutionCheckpoint,
  SquidExecutionStep,
  SquidPublicClient,
  SquidQuote,
  SquidWalletClient,
} from "./types.js"

type Transaction = { to: Address; data: Hex; value: bigint; nonce: number }

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase()
}

function stepKey(kind: SquidExecutionStep["kind"], requirementId: string) {
  return `${kind}:${requirementId}`
}

function step(
  checkpoint: SquidExecutionCheckpoint,
  kind: SquidExecutionStep["kind"],
  requirementId: string,
) {
  return checkpoint.steps.find(
    (item) =>
      stepKey(item.kind, item.requirementId) === stepKey(kind, requirementId),
  )
}

function checkpointWith(
  checkpoint: SquidExecutionCheckpoint,
  next: SquidExecutionStep,
): SquidExecutionCheckpoint {
  return {
    steps: [
      ...checkpoint.steps.filter(
        (item) =>
          stepKey(item.kind, item.requirementId) !==
          stepKey(next.kind, next.requirementId),
      ),
      next,
    ],
  }
}

function assertQuote(
  planned: SquidQuote,
  refreshed: SquidQuote,
  owner: Address,
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
    !sameAddress(refreshed.requirement.recipient, owner) ||
    refreshed.destinationAmount < planned.requirement.amount ||
    !sameAddress(refreshed.target, target) ||
    (refreshed.approvalSpender != null &&
      !sameAddress(refreshed.approvalSpender, spender)) ||
    refreshed.data === "0x" ||
    refreshed.value < 0n ||
    refreshed.value > refreshed.sourceAmount ||
    refreshed.expiresAt <= now
  )
    throw new Error("Refreshed Squid route failed execution trust checks")
}

async function fee(
  client: SquidPublicClient,
  transaction: Transaction,
  account: Address,
  opStack: boolean,
  buffer: ((totalFee: bigint) => bigint) | undefined,
) {
  if (opStack) {
    if (client.estimateTotalFee == null || buffer == null)
      throw new Error("OP Stack total-fee accounting and buffer are required")
    const estimated = await client.estimateTotalFee({ account, ...transaction })
    const buffered = buffer(estimated)
    if (buffered < estimated)
      throw new Error("OP Stack fee buffer must not reduce the total fee")
    return buffered
  }
  const [gas, fees] = await Promise.all([
    client.estimateGas({ account, ...transaction }),
    client.estimateFeesPerGas(),
  ])
  const perGas = fees.maxFeePerGas ?? fees.gasPrice
  if (perGas == null) throw new Error("Complete execution fee is unavailable")
  return gas * perGas
}

async function balance(
  client: SquidPublicClient,
  token: Address,
  owner: Address,
  native: boolean,
) {
  if (native) return client.getBalance({ address: owner })
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })
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
    status: (quote: SquidQuote) => Promise<"pending" | "success" | "failed">
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
  if (
    (await dependencies.publicClient.getChainId()) !==
    input.source.chain.chainId
  )
    throw new Error("Source RPC chain does not match the Squid source chain")
  const accounts = await dependencies.walletClient.getAddresses()
  if (!accounts.some((address) => sameAddress(address, input.account)))
    throw new Error("Wallet client does not control the requested account")
  if (
    input.quotes.some(
      (quote) =>
        quote.source !== input.source &&
        (!sameAddress(quote.source.token, input.source.token) ||
          quote.source.chain.chainId !== input.source.chain.chainId),
    )
  )
    throw new Error("All execution quotes must use the supplied source token")
  const sourceAmount = input.quotes.reduce(
    (total, quote) => total + quote.sourceAmount,
    0n,
  )
  if (sourceAmount > input.maxSourceAmount)
    throw new Error("Execution would exceed the source-token cap")
  const [sourceBalance, nativeBalance, nonce] = await Promise.all([
    balance(
      dependencies.publicClient,
      input.source.token,
      input.account,
      input.source.native,
    ),
    dependencies.publicClient.getBalance({ address: input.account }),
    dependencies.publicClient.getTransactionCount({
      address: input.account,
      blockTag: "pending",
    }),
  ])
  if (sourceBalance < sourceAmount + (input.sourceBalanceFloor ?? 0n))
    throw new Error("Source-token balance would cross its required floor")
  if (nativeBalance < (input.nativeBalanceFloor ?? 0n))
    throw new Error("Native balance would cross its required floor")
  let checkpoint = (await dependencies.load()) ?? { steps: [] }
  if (
    checkpoint.steps.some(
      (item) =>
        item.nativeFee == null ||
        typeof item.nativeFee !== "bigint" ||
        item.nativeFee < 0n,
    )
  )
    throw new Error("Checkpoint has an invalid native-fee commitment")
  let nextNonce = nonce
  let totalNativeFee = checkpoint.steps.reduce(
    (total, item) => total + item.nativeFee,
    0n,
  )
  if (totalNativeFee > input.maxNativeFee)
    throw new Error("Checkpoint exceeds the total-native-fee cap")
  let routeNativeValue = 0n
  const now = Math.floor((dependencies.now ?? Date.now)() / 1000)

  const run = async (
    kind: SquidExecutionStep["kind"],
    requirementId: string,
    transaction: Transaction,
  ) => {
    const current = step(checkpoint, kind, requirementId)
    if (current?.receiptStatus === "success") return
    if (current != null && current.transactionHash == null)
      throw new Error(
        "Checkpoint intent has no transaction hash; reconcile manually before resuming",
      )
    if (current?.transactionHash != null) {
      const receipt = await dependencies.publicClient.waitForTransactionReceipt(
        { hash: current.transactionHash },
      )
      checkpoint = checkpointWith(checkpoint, {
        ...current,
        receiptStatus: receipt.status,
      })
      await dependencies.save(checkpoint)
      if (receipt.status !== "success")
        throw new Error("Resumed transaction reverted")
      return
    }
    const candidate = { ...transaction, nonce: nextNonce }
    const estimatedFee = await fee(
      dependencies.publicClient,
      candidate,
      input.account,
      input.opStack === true,
      input.opStackFeeBuffer,
    )
    if (totalNativeFee + estimatedFee > input.maxNativeFee)
      throw new Error("Execution would exceed the total-native-fee cap")
    totalNativeFee += estimatedFee
    if (
      nativeBalance <
      (input.nativeBalanceFloor ?? 0n) +
        totalNativeFee +
        (input.source.native ? sourceAmount : routeNativeValue)
    )
      throw new Error(
        "Native balance would not cover the source amount and fees",
      )
    const intent: SquidExecutionStep = {
      kind,
      requirementId,
      nativeFee: estimatedFee,
    }
    checkpoint = checkpointWith(checkpoint, intent)
    await dependencies.save(checkpoint)
    const transactionHash = (await dependencies.walletClient.sendTransaction({
      account: input.account,
      chain: undefined,
      ...candidate,
    })) as Hash
    nextNonce += 1
    const sent = { ...intent, transactionHash }
    checkpoint = checkpointWith(checkpoint, sent)
    await dependencies.save(checkpoint)
    const receipt = await dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    checkpoint = checkpointWith(checkpoint, {
      ...sent,
      receiptStatus: receipt.status,
    })
    await dependencies.save(checkpoint)
    if (receipt.status !== "success") throw new Error("Transaction reverted")
  }

  for (const planned of input.quotes) {
    const refreshed = await dependencies.refreshQuote(planned)
    assertQuote(
      planned,
      refreshed,
      input.account,
      input.trustedTarget,
      input.trustedSpender,
      now,
    )
    const destinationClient = dependencies.destinationClient(
      refreshed.requirement.chainId,
    )
    if (
      (await destinationClient.getChainId()) !== refreshed.requirement.chainId
    )
      throw new Error("Destination RPC chain does not match the Squid route")
    const before = await balance(
      destinationClient,
      refreshed.requirement.token,
      refreshed.requirement.recipient,
      false,
    )
    if (!input.source.native) {
      const allowance = await dependencies.publicClient.readContract({
        address: input.source.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.account, input.trustedSpender],
      })
      if (allowance < refreshed.sourceAmount && allowance > 0n) {
        await run("approval", `${refreshed.requirement.id}:reset`, {
          to: input.source.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [input.trustedSpender, 0n],
          }),
          value: 0n,
          nonce: 0,
        })
      }
      if (allowance < refreshed.sourceAmount) {
        await run("approval", refreshed.requirement.id, {
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
    }
    routeNativeValue += refreshed.value
    await run("route", refreshed.requirement.id, {
      to: refreshed.target,
      data: refreshed.data,
      value: refreshed.value,
      nonce: 0,
    })
    let complete = false
    for (let attempt = 0; attempt < input.maxPollAttempts; attempt += 1) {
      const [routeStatus, after] = await Promise.all([
        dependencies.status(refreshed),
        balance(
          destinationClient,
          refreshed.requirement.token,
          refreshed.requirement.recipient,
          false,
        ),
      ])
      if (routeStatus === "failed") throw new Error("Squid route failed")
      if (
        routeStatus === "success" &&
        after >= before + refreshed.requirement.amount
      ) {
        complete = true
        break
      }
    }
    if (!complete)
      throw new Error("Squid route did not complete within the poll limit")
  }
  return checkpoint
}
