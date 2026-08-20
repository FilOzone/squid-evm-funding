import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hash,
  type Hex,
} from "viem"
import { fetchSquidStatus, quoteSquidRoute } from "./squid.js"
import {
  NATIVE_TOKEN_ADDRESS,
  type SquidClientOptions,
  type SquidExecutionResult,
  type SquidFundingPlan,
  type SquidPriceQuote,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from "./types.js"

type Transaction = { to: Address; data: Hex; value: bigint }
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

function assertQuote(
  planned: SquidPriceQuote,
  refreshed: SquidQuote,
  source: SquidFundingPlan["source"],
  target: Address,
  spender: Address,
  now: number,
) {
  if (
    refreshed.requirement.id !== planned.requirement.id ||
    refreshed.sourceAmount !== planned.sourceAmount ||
    refreshed.requirement.chainId !== planned.requirement.chainId ||
    !sameAddress(refreshed.requirement.token, planned.requirement.token) ||
    !sameAddress(
      refreshed.requirement.recipient,
      planned.requirement.recipient,
    ) ||
    refreshed.destinationAmount < planned.requirement.amount ||
    refreshed.id.trim() === "" ||
    !sameAddress(refreshed.target, target) ||
    (!native(source.token) && refreshed.approvalSpender == null) ||
    (refreshed.approvalSpender != null &&
      !sameAddress(refreshed.approvalSpender, spender)) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(refreshed.data) ||
    !Number.isSafeInteger(refreshed.expiresAt) ||
    refreshed.expiresAt <= now ||
    (native(source.token) && refreshed.value !== refreshed.sourceAmount) ||
    (!native(source.token) && refreshed.value !== 0n)
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
  publicClient: SquidPublicClient,
  walletClient: SquidWalletClient,
  transaction: Transaction,
  nonce: number,
  feeMode: "standard" | "op-stack",
  buffer: ((totalFee: bigint) => bigint) | undefined,
) {
  const request = await walletClient.prepareTransactionRequest({
    account: walletClient.account,
    chain: undefined,
    ...transaction,
    nonce,
  })
  const gas = request.gas
  const maxFeePerGas = request.maxFeePerGas
  const maxPriorityFeePerGas = request.maxPriorityFeePerGas
  const gasPrice = request.gasPrice
  const hasLegacyFee = gasPrice != null && gasPrice > 0n
  const hasEip1559Fee =
    maxFeePerGas != null &&
    maxPriorityFeePerGas != null &&
    maxFeePerGas > 0n &&
    maxPriorityFeePerGas >= 0n &&
    maxPriorityFeePerGas <= maxFeePerGas
  if (gas == null || gas <= 0n || (!hasLegacyFee && !hasEip1559Fee))
    throw new Error("Complete execution fee is unavailable")

  if (feeMode === "standard")
    return {
      fee:
        gas * (hasLegacyFee ? (gasPrice as bigint) : (maxFeePerGas as bigint)),
      request,
    }
  if (publicClient.estimateTotalFee == null || buffer == null)
    throw new Error("OP Stack total-fee accounting and buffer are required")
  const total = await publicClient.estimateTotalFee({
    account: walletClient.account.address,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    nonce,
    gas,
    ...(gasPrice == null ? {} : { gasPrice }),
    ...(maxFeePerGas == null ? {} : { maxFeePerGas }),
    ...(maxPriorityFeePerGas == null ? {} : { maxPriorityFeePerGas }),
  })
  const fee = buffer(total)
  if (fee < total)
    throw new Error("OP Stack fee buffer must not reduce the total fee")
  return { fee, request }
}

export async function executeSquidFunding(
  input: {
    plan: SquidFundingPlan
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
    destinationClient: SquidPublicClient
    squid: SquidClientOptions
    sleep?: (milliseconds: number) => Promise<void>
  },
): Promise<SquidExecutionResult> {
  const { plan } = input
  if (
    plan.quotes.length === 0 ||
    plan.maxSourceAmount <= 0n ||
    input.maxNativeFee < 0n ||
    (input.sourceBalanceFloor ?? 0n) < 0n ||
    (input.nativeBalanceFloor ?? 0n) < 0n ||
    plan.quotes.some(
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
    new Set(plan.quotes.map((quote) => quote.requirement.id)).size !==
    plan.quotes.length
  )
    throw new Error("Execution requirement IDs must be unique")
  const destinationChainIds = new Set(
    plan.quotes.map((quote) => quote.requirement.chainId),
  )
  if (destinationChainIds.size !== 1)
    throw new Error("All requirements must use one destination chain")

  const sourceAmount = plan.quotes.reduce(
    (total, quote) => total + quote.sourceAmount,
    0n,
  )
  if (sourceAmount > plan.maxSourceAmount)
    throw new Error("Execution would exceed the source-token cap")
  if ((await dependencies.publicClient.getChainId()) !== plan.source.chainId)
    throw new Error("Source RPC chain does not match the Squid source chain")
  if ((await dependencies.walletClient.getChainId()) !== plan.source.chainId)
    throw new Error("Wallet chain does not match the Squid source chain")
  if (!sameAddress(dependencies.walletClient.account.address, plan.owner))
    throw new Error("Wallet client does not control the requested account")
  const destinationChainId = destinationChainIds.values().next().value
  if (
    destinationChainId == null ||
    (await dependencies.destinationClient.getChainId()) !== destinationChainId
  )
    throw new Error("Destination RPC chain does not match the Squid route")

  const refresh = (quote: SquidPriceQuote) =>
    quoteSquidRoute(
      {
        owner: plan.owner,
        source: plan.source,
        requirement: quote.requirement,
        sourceAmount: quote.sourceAmount,
        slippage: plan.slippage,
      },
      dependencies.squid,
    )
  const now = () => Math.floor((dependencies.squid.now ?? Date.now)() / 1000)
  let totalNativeFee = 0n
  const routes: Array<{ requirementId: string; transactionHash: Hash }> = []
  const send = async (
    transaction: Transaction,
    remainingSource: bigint,
    validate?: () => void,
  ) => {
    const [latestNonce, pendingNonce] = await Promise.all([
      dependencies.publicClient.getTransactionCount({
        address: plan.owner,
        blockTag: "latest",
      }),
      dependencies.publicClient.getTransactionCount({
        address: plan.owner,
        blockTag: "pending",
      }),
    ])
    if (latestNonce !== pendingNonce)
      throw new Error("Source account has pending transactions")
    const prepared = await prepare(
      dependencies.publicClient,
      dependencies.walletClient,
      transaction,
      pendingNonce,
      input.feeMode,
      input.opStackFeeBuffer,
    )
    if (totalNativeFee + prepared.fee > input.maxNativeFee)
      throw new Error("Execution would exceed the total-native-fee cap")
    const [nativeBalance, sourceBalance] = await Promise.all([
      dependencies.publicClient.getBalance({ address: plan.owner }),
      native(plan.source.token)
        ? Promise.resolve(undefined)
        : balance(dependencies.publicClient, plan.source.token, plan.owner),
    ])
    if (native(plan.source.token)) {
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
        address: plan.owner,
        blockTag: "pending",
      })) !== pendingNonce
    )
      throw new Error("Pending nonce changed before broadcast")
    if ((await dependencies.walletClient.getChainId()) !== plan.source.chainId)
      throw new Error("Wallet chain does not match the Squid source chain")
    validate?.()
    totalNativeFee += prepared.fee
    const transactionHash = (await dependencies.walletClient.sendTransaction({
      ...prepared.request,
      account: dependencies.walletClient.account,
      chain: undefined,
    } as never)) as Hash
    const receipt = await dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    if (receipt.status !== "success") throw new Error("Transaction reverted")
    return transactionHash
  }

  for (let index = 0; index < plan.quotes.length; index += 1) {
    const planned = plan.quotes[index] as SquidPriceQuote
    const remainingSource = plan.quotes
      .slice(index)
      .reduce((total, quote) => total + quote.sourceAmount, 0n)
    const before =
      (await balance(
        dependencies.destinationClient,
        planned.requirement.token,
        planned.requirement.recipient,
      )) + planned.requirement.amount

    if (!native(plan.source.token)) {
      let allowance = await dependencies.publicClient.readContract({
        address: plan.source.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [plan.owner, input.trustedSpender],
      })
      if (allowance !== planned.sourceAmount) {
        if (allowance > 0n)
          await send(
            {
              to: plan.source.token,
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
            to: plan.source.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [input.trustedSpender, planned.sourceAmount],
            }),
            value: 0n,
          },
          remainingSource,
        )
        allowance = await dependencies.publicClient.readContract({
          address: plan.source.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [plan.owner, input.trustedSpender],
        })
        if (allowance !== planned.sourceAmount)
          throw new Error(
            "Exact source-token allowance is required after approval",
          )
      }
    }
    const refreshed = await refresh(planned)
    assertQuote(
      planned,
      refreshed,
      plan.source,
      input.trustedTarget,
      input.trustedSpender,
      now(),
    )
    const transactionHash = await send(
      {
        to: refreshed.target,
        data: refreshed.data,
        value: refreshed.value,
      },
      remainingSource,
      () =>
        assertQuote(
          planned,
          refreshed,
          plan.source,
          input.trustedTarget,
          input.trustedSpender,
          now(),
        ),
    )
    let complete = false
    for (let attempt = 0; attempt < input.maxPollAttempts; attempt += 1) {
      // The source transaction is already committed here, so a failed
      // status or balance read only spends a poll attempt; it must never
      // abandon a route that may still complete.
      const [statusResult, balanceResult] = await Promise.allSettled([
        fetchSquidStatus(
          {
            quoteId: refreshed.id,
            transactionHash,
            fromChainId: plan.source.chainId,
            toChainId: refreshed.requirement.chainId,
          },
          dependencies.squid,
        ),
        balance(
          dependencies.destinationClient,
          planned.requirement.token,
          planned.requirement.recipient,
        ),
      ])
      const routeStatus =
        statusResult.status === "fulfilled" ? statusResult.value : "pending"
      if (routeStatus === "failed") throw new Error("Squid route failed")
      if (
        routeStatus === "success" &&
        balanceResult.status === "fulfilled" &&
        balanceResult.value >= before
      ) {
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
