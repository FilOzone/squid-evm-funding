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
- **Operation:** one stable logical execution, identified by `operationId` and
  resumed from an authenticated checkpoint.

## Plan and execute a route

The caller owns the account, RPC URLs, integrator ID, trust policy, caps, and
checkpoint storage. This example uses Arbitrum USDC as the source and Filecoin
USDFC as the destination, but the package itself accepts Squid-supported EVM
chains and tokens.

```ts
import {
  executeSquidFunding,
  fetchSquidCatalog,
  planSquidFunding,
  quoteSquidRoute,
  resolveSourceToken,
  type SquidExecutionCheckpoint,
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
declare const checkpointIntegrityKey: Hex

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

// Demo only. Use durable, monotonic storage before routing real funds.
let checkpoint: SquidExecutionCheckpoint | undefined
const result = await executeSquidFunding(
  {
    operationId: "fund-filecoin-pay-2026-07-28-01",
    checkpointIntegrityKey,
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
    load: async () => checkpoint,
    save: async (next) => {
      checkpoint = next
    },
  },
)
```

`sourcePrivateKey`, RPC URLs, token and trusted contract addresses,
`integratorId`, and `checkpointIntegrityKey` above are application-owned
configuration. The package never reads them from the environment. The in-memory
checkpoint store is only enough to make the flow visible; it is not safe for a
real transfer.

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
  and confirms the destination balance. It returns the final checkpoint.
- `sealSquidExecutionCheckpoint` authenticates a checkpoint after the caller
  has manually reconciled an interrupted send.

The exported types are `DestinationRequirement`, `SourceToken`, `SquidCatalog`,
`SquidChain`, `SquidClientOptions`, `SquidExecutionCheckpoint`,
`SquidExecutionStep`, `SquidPublicClient`, `SquidQuote`,
`SquidStatusReference`, and `SquidWalletClient`. Applications can therefore
implement clients, status callbacks, and checkpoint stores without importing
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

## Checkpoints and recovery

Use one nonblank, stable `operationId` for one logical execution and all its
retries. It is bound to the account, source identity, destination requirements,
planned source amounts, trusted addresses, and fee mode. Changing those inputs
or reusing a checkpoint for a different operation is rejected.

Generate and retain a separate 32-byte `checkpointIntegrityKey`. It is an HMAC
key, not the wallet private key, and it must not be stored beside the
checkpoint. A checkpoint contains execution metadata such as addresses, nonces,
fee commitments, transaction hashes, and calldata hashes; it contains neither
key. Authentication detects edits but does not encrypt a checkpoint or prove it
is the newest valid version. Treat the checkpoint as application operational
data even though it contains no signing or integrity secret.

`load` and `save` therefore need durable, atomic, monotonically advancing
storage. A valid older checkpoint can omit a later send, so storage rollback can
create duplicate-spend risk even though its HMAC is valid. Persist every saved
checkpoint before allowing the operation to continue, and preserve `bigint`
values when serializing it.

If execution stops after saving an intent but before saving its transaction
hash, it will not guess or resubmit. Reconcile the wallet and source chain
manually:

1. If the transaction was broadcast, attach its recovered hash to the matching
   step. If it is proven unsent, remove that hashless step.
2. Call `sealSquidExecutionCheckpoint` with the same integrity key.
3. Durably save the sealed checkpoint, then resume with the same operation and
   execution inputs.

The sealer authenticates the caller's reconciliation decision; it does not
inspect the chain or decide whether a transaction was sent.
