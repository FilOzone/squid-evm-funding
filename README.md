# squid-evm-funding

Small TypeScript helpers for planning and executing capped EVM token routes
through [Squid](https://www.squidrouter.com/). The package uses Squid's v2 API,
built-in `fetch`, and caller-created [viem](https://viem.sh/) clients.

Requires Node.js 24 or newer.

```sh
pnpm add squid-evm-funding viem
```

## Terms

- **Requirement:** a token amount that must arrive at a recipient on one
  destination EVM chain.
- **Source:** the caller-selected chain and Squid-catalog token to spend.
- **Plan:** validated fixed-input routes that fit one source-token cap.
- **Execution:** refreshed, guarded transactions followed by receipt, Squid
  status, and destination-balance checks.

## Usage

The public API has two operations: `planSquidFunding` and
`executeSquidFunding`. The caller owns the account, RPC URLs, trusted Squid
addresses, fee policy, and integrator ID.

```ts
import { executeSquidFunding, planSquidFunding } from "squid-evm-funding"
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
const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(sourceRpcUrl),
})
const walletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(sourceRpcUrl),
})
const destinationClient = createPublicClient({
  chain: filecoin,
  transport: http(filecoinRpcUrl),
})
const squid = { integratorId }

const plan = await planSquidFunding(
  {
    owner: account.address,
    sourceChainId: arbitrum.id,
    sourceToken: "USDC", // "native", an address, or an unambiguous symbol
    requirements: [
      {
        id: "filecoin-pay-shortfall",
        chainId: filecoin.id,
        token: usdfcAddress,
        amount: parseUnits("2", 18),
        recipient: account.address,
      },
    ],
    maxSourceAmount: "3",
    slippage: 1,
  },
  squid,
)

const result = await executeSquidFunding(
  {
    plan,
    maxNativeFee: parseEther("0.005"),
    sourceBalanceFloor: 0n,
    nativeBalanceFloor: parseEther("0.001"),
    trustedTarget: squidRouterAddress,
    trustedSpender: squidApprovalSpender,
    feeMode: "standard",
    maxPollAttempts: 60,
    pollIntervalMs: 5_000,
  },
  { publicClient, walletClient, destinationClient, squid },
)
```

The package never reads private keys, RPC URLs, or the integrator ID from the
environment. It fetches Squid's token catalog during planning, so source tokens
are not limited to a package-maintained token list. The host remains responsible
for deciding which EVM source chains it supports.

## Execution constraints

Execution fails closed unless:

- planned source amounts fit `maxSourceAmount`;
- RPC and account-bound wallet clients match the source chain and owner;
- every requirement uses the destination client's chain;
- refreshed routes preserve source amount and destination identity, remain
  unexpired, and use caller-trusted target and spender addresses;
- source and native balances preserve the optional caller-selected floors;
- no pending transaction or nonce change makes the next send ambiguous;
- exact ERC-20 allowances, source receipts, Squid success, and destination
  balance arrival are verified.

`maxNativeFee` bounds cumulative fee commitments for approvals and routes. For
OP Stack chains, use `feeMode: "op-stack"`, provide an `estimateTotalFee`
extension that includes execution, L1 data, and operator fees, and supply a
conservative `opStackFeeBuffer`. Execution fails if complete fee accounting is
unavailable.

The executor is stateless. A host that must block a rerun after interruption
should place one coarse marker around `executeSquidFunding` and require manual
verification before removing an ambiguous marker.
