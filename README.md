# squid-evm-funding

Small TypeScript helpers for planning and executing capped EVM token routes
through [Squid](https://www.squidrouter.com/). The package uses Squid's v2 HTTP
API, built-in `fetch`, and caller-created [viem](https://viem.sh/) clients. It
does not accept private keys, choose a source token, read balances to recommend
a source, or expose a Filecoin-specific API.

Requires Node.js 24 or newer.

```sh
pnpm add squid-evm-funding viem
```

## Terms

- **Requirement:** one token amount that must arrive at a recipient on a
  destination EVM chain.
- **Source:** the chain and token the caller permits Squid to spend.
- **Quote:** one validated, fixed-input Squid route for one requirement.
- **Execution:** one guarded call that plans, validates, broadcasts, verifies,
  and returns transaction hashes.

## Plan and execute a route

The caller owns the account, RPC URLs, integrator ID, trust policy, caps, and
trusted contract addresses. This example uses Arbitrum USDC as the source and Filecoin
USDFC as the destination. Source selection is limited to Filecoin, Arbitrum,
Ethereum, Base, Optimism, Polygon, Avalanche, and BNB Chain.

```ts
import {
  executeSquidFunding,
  fetchSquidCatalog,
  planSquidFunding,
  quoteSquidRoute,
  resolveSourceToken,
} from "squid-evm-funding"
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { arbitrum, filecoin } from "viem/chains"

declare const sourcePrivateKey: Hex
declare const sourceRpcUrl: string
declare const filecoinRpcUrl: string
declare const integratorId: string
declare const usdfcAddress: Address
declare const squidRouterAddress: Address
declare const squidApprovalSpender: Address

const account = privateKeyToAccount(sourcePrivateKey)
const sourcePublicClient = createPublicClient({
  chain: arbitrum,
  transport: http(sourceRpcUrl),
})
const sourceWalletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(sourceRpcUrl),
})
const filecoinPublicClient = createPublicClient({
  chain: filecoin,
  transport: http(filecoinRpcUrl),
})

const squid = { integratorId }
const catalog = await fetchSquidCatalog(squid)
const source = resolveSourceToken(catalog, arbitrum.id, "USDC")
const requirements = [
  {
    id: "filecoin-pay-shortfall",
    chainId: filecoin.id,
    token: usdfcAddress,
    amount: parseUnits("2", 18),
    recipient: account.address,
  },
]
const maxSourceAmount = parseUnits("3", source.decimals)
const slippage = 1
const quotes = await planSquidFunding(
  {
    owner: account.address,
    source,
    requirements,
    maxSourceAmount,
    slippage,
  },
  squid,
)

const result = await executeSquidFunding(
  {
    account: account.address,
    source,
    quotes,
    maxSourceAmount,
    maxNativeFee: parseEther("0.005"),
    sourceBalanceFloor: 0n,
    nativeBalanceFloor: parseEther("0.001"),
    // Resolve these independently from an approved deployment, not from a quote.
    trustedTarget: squidRouterAddress,
    trustedSpender: squidApprovalSpender,
    feeMode: "standard",
    maxPollAttempts: 60,
    pollIntervalMs: 5_000,
  },
  {
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
    destinationClient: (chainId) => {
      if (chainId !== filecoin.id)
        throw new Error(`unsupported destination ${chainId}`)
      return filecoinPublicClient
    },
    refreshQuote: (planned) =>
      quoteSquidRoute(
        {
          owner: account.address,
          source: planned.source,
          requirement: planned.requirement,
          sourceAmount: planned.sourceAmount,
          slippage,
        },
        squid,
      ),
    squidStatusOptions: squid,
  },
)
```

`sourcePrivateKey`, RPC URLs, token and trusted contract addresses, and
`integratorId` above are application-owned configuration. The package never
reads them from the environment.

## Public API

- `fetchSquidCatalog` fetches Squid's EVM chain and token catalogs;
  `parseSquidCatalog` validates previously fetched catalog payloads.
- `resolveSourceToken` selects `native`, an address, or an unambiguous symbol on
  a caller-selected source chain. `NATIVE_TOKEN_ADDRESS` is the normalized
  native-token sentinel.
- `quoteSquidRoute` validates one fixed-input route and returns its transaction,
  source identity, destination minimum, request identity, and expiry.
  `SquidMinimumAmountError` identifies an explicit provider minimum.
- `planSquidFunding` quotes each requirement, proportionally reduces successful
  seed quotes, and shares one `maxSourceAmount` across every leg. It performs at
  most four quotes per leg and fails when the cap, provider minimum, expiry, or
  convergence bound cannot be satisfied.
- `fetchSquidStatus` fetches one route status; `parseSquidStatus` normalizes a
  previously fetched Squid status response.
- `executeSquidFunding` refreshes and validates routes, sends exact ERC-20
  approvals when needed, sends route transactions, polls bounded completion,
  and confirms the destination balance. It returns source amount, total native
  fee, and route transaction hashes.

The exported types are `DestinationRequirement`, `SourceToken`, `SquidCatalog`,
`SquidChain`, `SquidClientOptions`, `SquidExecutionResult`,
`SquidPublicClient`, `SquidQuote`,
`SquidStatusReference`, and `SquidWalletClient`. Applications can therefore
implement clients and status callbacks without importing
internal modules.

## Execution constraints

Execution is deliberately opt-in and fail-closed:

- All planned source amounts must fit `maxSourceAmount`. `maxNativeFee` bounds
  the cumulative fee commitments for approvals and routes, while optional
  source and native balance floors preserve caller-selected reserves.
- `trustedTarget` and `trustedSpender` are caller policy. Resolve them from an
  independently approved Squid deployment or allowlist; do not trust an address
  merely because the same route response supplied it.
- The wallet and public client must match the source chain and account. The
  destination client must match each requirement. Execution refuses to start a
  send while the account has a pending source-chain transaction.
- ERC-20 allowances are reset when required and set to the exact refreshed
  source amount. Route identity and expiry are checked again at the send
  boundary.
- `maxPollAttempts` and `pollIntervalMs` bound status polling. Provider and RPC
  request timeouts remain the caller's responsibility.

For ordinary EVM chains, use `feeMode: "standard"`. For OP Stack chains, use
`feeMode: "op-stack"`, extend the source public client with `estimateTotalFee`,
and provide `opStackFeeBuffer`. `estimateTotalFee` must include L2 execution,
L1 data, and operator fee components for every approval and route transaction.
The buffer must not reduce that estimate and should conservatively cover fee
movement before inclusion. Execution fails closed if either total-fee
accounting or the buffer is missing.

Provide either a custom `status` callback or `squidStatusOptions`. A callable
`status` callback takes precedence when both are present. Otherwise valid Squid
options are required and the built-in status request is used.

## Interrupted executions

The executor is intentionally stateless. An interruption can leave the
destination ambiguous, so the host must record one coarse in-progress marker
around the call and require manual verification before another run. It never
replays, reconstructs, or resumes a prior transaction.
