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
  SquidExecutionResult,
  SquidPublicClient,
  SquidQuote,
  SquidStatusReference,
  SquidWalletClient,
} from "./types.js"
import { NATIVE_TOKEN_ADDRESS } from "./types.js"

type Transaction = { to: Address; data: Hex; value: bigint; gas?: bigint }
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
    (options.baseUrl === undefined || typeof options.baseUrl === "string") &&
    (options.fetch === undefined || typeof options.fetch === "function")
  )
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
    refreshed.destinationAmount < planned.requirement.amount ||
    refreshed.gasLimit <= 0n ||
    refreshed.id.trim() === "" ||
    (refreshed.requestId != null && refreshed.requestId.trim() === "") ||
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
  nonce: number,
  feeMode: "standard" | "op-stack",
  buffer: ((totalFee: bigint) => bigint) | undefined,
) {
  const base = { ...transaction, nonce }
  const [estimatedGas, fees] = await Promise.all([
    client.estimateGas({ account, ...base }),
    client.estimateFeesPerGas(),
  ])
  const gas =
    transaction.gas != null && transaction.gas > estimatedGas
      ? transaction.gas
      : estimatedGas
  if (gas <= 0n) throw new Error("Complete execution fee is unavailable")
  const feeFields =
    fees.maxFeePerGas != null &&
    fees.maxPriorityFeePerGas != null &&
    fees.maxFeePerGas > 0n &&
    fees.maxPriorityFeePerGas >= 0n &&
    fees.maxPriorityFeePerGas <= fees.maxFeePerGas
      ? {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      : fees.maxFeePerGas == null && fees.gasPrice != null && fees.gasPrice > 0n
        ? { gasPrice: fees.gasPrice }
        : undefined
  if (feeFields == null)
    throw new Error("Complete execution fee is unavailable")
  const request = { ...base, gas, ...feeFields }
  if (feeMode === "standard") {
    const perGas = (
      "gasPrice" in feeFields ? feeFields.gasPrice : feeFields.maxFeePerGas
    ) as bigint
    return { fee: gas * perGas, request }
  }
  if (client.estimateTotalFee == null || buffer == null)
    throw new Error("OP Stack total-fee accounting and buffer are required")
  const total = await client.estimateTotalFee({ account, ...request })
  const fee = buffer(total)
  if (fee < total)
    throw new Error("OP Stack fee buffer must not reduce the total fee")
  return { fee, request }
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
    now?: () => number
    sleep?: (milliseconds: number) => Promise<void>
  },
): Promise<SquidExecutionResult> {
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
  if (
    new Set(input.quotes.map((quote) => quote.requirement.id)).size !==
    input.quotes.length
  )
    throw new Error("Execution requirement IDs must be unique")
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
  if (dependencies.status != null && typeof dependencies.status !== "function")
    throw new Error("Squid status callback must be callable")
  const status =
    dependencies.status ??
    (validStatusOptions(dependencies.squidStatusOptions)
      ? (reference: SquidStatusReference, transactionHash: Hash) =>
          fetchSquidStatus(
            { status: reference, transactionHash },
            dependencies.squidStatusOptions as SquidClientOptions,
          )
      : undefined)
  if (status == null)
    throw new Error("Squid status options or a status callback are required")
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
  let totalNativeFee = 0n
  const routes: Array<{ requirementId: string; transactionHash: Hash }> = []
  const send = async (
    transaction: Transaction,
    remainingSource: bigint,
    validate?: () => void,
  ) => {
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
      transaction,
      input.account,
      pendingNonce,
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
    if (
      (await dependencies.publicClient.getTransactionCount({
        address: input.account,
        blockTag: "pending",
      })) !== pendingNonce
    )
      throw new Error("Pending nonce changed before broadcast")
    if (
      (await dependencies.walletClient.getChainId()) !==
      input.source.chain.chainId
    )
      throw new Error("Wallet chain does not match the Squid source chain")
    validate?.()
    totalNativeFee += prepared.fee
    const transactionHash = (await dependencies.walletClient.sendTransaction({
      account: configuredAccount ?? input.account,
      chain: undefined,
      ...prepared.request,
    } as never)) as Hash
    const receipt = await dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    if (receipt.status !== "success") throw new Error("Transaction reverted")
    return transactionHash
  }
  for (let index = 0; index < input.quotes.length; index += 1) {
    const planned = input.quotes[index] as SquidQuote
    const destinationClient = dependencies.destinationClient(
      planned.requirement.chainId,
    )
    if ((await destinationClient.getChainId()) !== planned.requirement.chainId)
      throw new Error("Destination RPC chain does not match the Squid route")
    let refreshed = await dependencies.refreshQuote(planned)
    const now = () => Math.floor((dependencies.now ?? Date.now)() / 1000)
    assertQuote(
      planned,
      refreshed,
      input.trustedTarget,
      input.trustedSpender,
      now(),
    )
    const remainingSource = input.quotes
      .slice(index)
      .reduce((total, quote) => total + quote.sourceAmount, 0n)
    const before =
      (await balance(
        destinationClient,
        planned.requirement.token,
        planned.requirement.recipient,
      )) + planned.requirement.amount
    if (!input.source.native) {
      let allowance = await dependencies.publicClient.readContract({
        address: input.source.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.account, input.trustedSpender],
      })
      if (allowance !== refreshed.sourceAmount) {
        if (allowance > 0n)
          await send(
            {
              to: input.source.token,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [input.trustedSpender, 0n],
              }),
              value: 0n,
            },
            remainingSource,
          )
        await send(
          {
            to: input.source.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [input.trustedSpender, refreshed.sourceAmount],
            }),
            value: 0n,
          },
          remainingSource,
        )
        refreshed = await dependencies.refreshQuote(planned)
        assertQuote(
          planned,
          refreshed,
          input.trustedTarget,
          input.trustedSpender,
          now(),
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
    assertQuote(
      planned,
      refreshed,
      input.trustedTarget,
      input.trustedSpender,
      now(),
    )
    const transactionHash = await send(
      {
        to: refreshed.target,
        data: refreshed.data,
        value: refreshed.value,
        gas: refreshed.gasLimit,
      },
      remainingSource,
      () =>
        assertQuote(
          planned,
          refreshed,
          input.trustedTarget,
          input.trustedSpender,
          now(),
        ),
    )
    const reference = {
      quoteId: refreshed.id,
      ...(refreshed.requestId == null
        ? {}
        : { requestId: refreshed.requestId }),
      fromChainId: refreshed.source.chain.chainId,
      toChainId: refreshed.requirement.chainId,
    }
    let complete = false
    for (let attempt = 0; attempt < input.maxPollAttempts; attempt += 1) {
      const [routeStatus, after] = await Promise.all([
        status(reference, transactionHash),
        balance(
          destinationClient,
          planned.requirement.token,
          planned.requirement.recipient,
        ),
      ])
      if (routeStatus === "failed") throw new Error("Squid route failed")
      if (routeStatus === "success" && after >= before) {
        complete = true
        break
      }
      if (attempt + 1 < input.maxPollAttempts)
        await (dependencies.sleep ?? sleep)(input.pollIntervalMs)
    }
    if (!complete)
      throw new Error("Squid route did not complete within the poll limit")
    routes.push({ requirementId: planned.requirement.id, transactionHash })
  }
  return { sourceAmount, nativeFee: totalNativeFee, routes }
}
