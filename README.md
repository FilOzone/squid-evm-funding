# squid-evm-funding

Minimal TypeScript helpers for acquiring an exact EVM token shortfall through
[Squid](https://www.squidrouter.com/). The package uses the Squid v2 HTTP API,
viem address types, and built-in `fetch`.

```ts
import { fetchSquidCatalog, planSquidFunding, resolveSourceToken } from "squid-evm-funding"

const catalog = await fetchSquidCatalog({ integratorId, fetch })
const source = resolveSourceToken(catalog, 42161, "USDC")
const quotes = await planSquidFunding(
  { owner, source, requirements, maxSourceAmount, slippage: 1 },
  { integratorId, fetch },
)
```

`planSquidFunding` returns fixed-input quotes for exact destination amounts. It
shares `maxSourceAmount` across all requirements and re-quotes a successful
seed down to the proportional input.

`executeSquidFunding` is the opt-in execution step. The caller supplies viem
public/wallet clients, account, route refresh/status functions, destination
clients, and checkpoint load/save callbacks. Each logical execution also has a
nonblank `operationId` and a caller-held 32-byte `checkpointIntegrityKey`.
Checkpoints are bound to that operation and authenticated with HMAC-SHA256
before any RPC call; every saved checkpoint is authenticated again. The key is
not stored in the checkpoint, and authentication does not encrypt the
non-sensitive checkpoint contents. Planning is read-only; execution asks the
supplied wallet client to sign and send each approval and route transaction.
The wallet must be on the source chain and control the requested account; a
configured local viem account is passed through unchanged. Immediately before
each broadcast, execution rechecks the wallet chain and route expiry; a failed
check clears the known-unsent intent. Execution uses only the caller-approved
route target and spender, persists intent before sending, and does not retry an
intent that has no transaction hash. If an allowance changes after a successful
approval, a new checkpointed attempt preserves the prior transaction and fee
history.

If execution stops with an intent that has no transaction hash, reconcile it
against the wallet and source chain before editing the checkpoint or attempting
another send. If the transaction was broadcast, attach its recovered hash to
the matching step. If it is proven not to have been broadcast, remove that
hashless step. Then call `sealSquidExecutionCheckpoint` with the same
`checkpointIntegrityKey`, save the returned checkpoint, and resume with the
same operation and execution inputs. The sealer authenticates the caller's
manual decision; it does not perform or replace the on-chain reconciliation.

```ts
import { sealSquidExecutionCheckpoint } from "squid-evm-funding"

const reconciled = sealSquidExecutionCheckpoint(
  { ...checkpoint, steps: reconciledSteps },
  checkpointIntegrityKey,
)
await save(reconciled)
```

Route completion is checked at most
`maxPollAttempts` times, with `pollIntervalMs` between attempts. The package
schedules no more than `(maxPollAttempts - 1) * pollIntervalMs` of polling
delay; RPC and provider request timeouts remain the caller's responsibility.
The package never accepts a private key, selects a source, or accesses
environment variables.

Implementation is tracked in [issue #1](https://github.com/snissn/squid-evm-funding/issues/1).
