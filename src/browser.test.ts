import { createWalletClient, custom } from "viem"
import { mainnet } from "viem/chains"
import { describe, expect, it } from "vitest"
import {
  executeSquidFunding,
  NATIVE_TOKEN_ADDRESS,
  planSquidFunding,
  type SquidPublicClient,
  type SquidWalletClient,
} from "./index.js"

const owner = "0x1111111111111111111111111111111111111111" as const
const destinationToken = "0x3333333333333333333333333333333333333333" as const
const target = "0x4444444444444444444444444444444444444444" as const
const spender = "0x5555555555555555555555555555555555555555" as const
const transactionHash = `0x${"a".repeat(64)}` as const

type ProviderRequest = {
  method: string
  params?: readonly unknown[]
}

function browserProvider() {
  const methods = [] as string[]
  const sent = [] as Array<Record<string, unknown>>
  return {
    methods,
    sent,
    request: async ({ method, params }: ProviderRequest) => {
      methods.push(method)
      if (method === "eth_requestAccounts") return [owner]
      if (method === "eth_chainId") return "0x1"
      if (method === "eth_sendTransaction") {
        const [transaction] = params as readonly [Record<string, unknown>]
        sent.push(transaction)
        return transactionHash
      }
      throw new Error(`Unexpected browser wallet method: ${method}`)
    },
  }
}

function squidFetch() {
  let routeCalls = 0
  return (async (input, init) => {
    const url = String(input)
    if (url.endsWith("/tokens"))
      return new Response(
        JSON.stringify({
          tokens: [
            {
              chainId: String(mainnet.id),
              address: NATIVE_TOKEN_ADDRESS,
              symbol: "ETH",
              decimals: 18,
            },
          ],
        }),
      )
    if (url.includes("/status?"))
      return new Response(JSON.stringify({ squidTransactionStatus: "success" }))

    routeCalls += 1
    const request = JSON.parse(String(init?.body)) as {
      fromAddress: string
      toAddress: string
      fromChain: string
      fromToken: string
      fromAmount: string
      toChain: string
      toToken: string
      slippage: number
      quoteOnly: boolean
    }
    return new Response(
      JSON.stringify({
        route: {
          quoteId: `browser-${routeCalls}`,
          params: request,
          estimate: { toAmountMin: request.fromAmount },
          transactionRequest: {
            target,
            approvalSpender: spender,
            data: "0x01",
            value: request.fromAmount,
            expiry: "2000000000",
          },
        },
      }),
    )
  }) as typeof globalThis.fetch
}

describe("browser package support", () => {
  it("plans and executes with the connected EIP-1193 address and chain", async () => {
    const provider = browserProvider()
    const transport = custom(provider)
    const connection = createWalletClient({ chain: mainnet, transport })
    const [connectedAddress] = await connection.requestAddresses()
    if (connectedAddress == null)
      throw new Error("The browser wallet returned no account")

    const walletClient = createWalletClient({
      account: connectedAddress,
      chain: mainnet,
      transport,
    }).extend(() => ({
      prepareTransactionRequest: async (request: Record<string, unknown>) => ({
        ...request,
        gas: 2n,
        maxFeePerGas: 3n,
        maxPriorityFeePerGas: 1n,
      }),
    })) as unknown as SquidWalletClient

    const sourceClient = {
      getChainId: async () => mainnet.id,
      getBalance: async () => 1_000n,
      getTransactionCount: async () => 7,
      readContract: async () => 0n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    } as unknown as SquidPublicClient
    let destinationReads = 0
    const destinationClient = {
      ...sourceClient,
      getChainId: async () => 314,
      readContract: async () => (destinationReads++ === 0 ? 0n : 10n),
    } as unknown as SquidPublicClient
    const squid = {
      integratorId: "browser-test",
      baseUrl: "https://example.test/v2",
      fetch: squidFetch(),
      now: () => 0,
    }

    const plan = await planSquidFunding(
      {
        owner: connectedAddress,
        sourceChainId: mainnet.id,
        sourceToken: "native",
        requirements: [
          {
            id: "browser-funding",
            chainId: 314,
            token: destinationToken,
            amount: 10n,
            recipient: connectedAddress,
          },
        ],
        maxSourceAmount: "0.00000000000000001",
        slippage: 1,
      },
      squid,
    )
    expect(plan.owner).toBe(owner)
    expect(plan.source.chainId).toBe(mainnet.id)

    await expect(
      executeSquidFunding(
        {
          plan,
          maxNativeFee: 6n,
          trustedTarget: target,
          trustedSpender: spender,
          feeMode: "standard",
          maxPollAttempts: 1,
          pollIntervalMs: 1,
        },
        {
          publicClient: sourceClient,
          walletClient,
          destinationClient,
          squid,
        },
      ),
    ).resolves.toEqual({
      sourceAmount: 10n,
      nativeFee: 6n,
      routes: [{ requirementId: "browser-funding", transactionHash }],
    })

    expect(provider.methods[0]).toBe("eth_requestAccounts")
    expect(
      provider.methods.filter((method) => method === "eth_chainId").length,
    ).toBeGreaterThanOrEqual(2)
    expect(provider.sent).toEqual([
      expect.objectContaining({
        from: owner,
        to: target,
        data: "0x01",
        value: "0xa",
        nonce: "0x7",
        gas: "0x2",
        maxFeePerGas: "0x3",
        maxPriorityFeePerGas: "0x1",
      }),
    ])
  })
})
