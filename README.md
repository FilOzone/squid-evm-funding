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
clients, and non-sensitive checkpoint load/save callbacks. Planning is
read-only; execution asks the supplied wallet client to sign and send each
approval and route transaction. The wallet must be on the source chain and
control the requested account; a configured local viem account is passed
through unchanged. Execution uses only the caller-approved route target and
spender, persists intent before sending, and does not retry an intent that has
no transaction hash. If an allowance changes after a successful approval, a
new checkpointed attempt preserves the prior transaction and fee history.
Route completion is checked at most
`maxPollAttempts` times, with `pollIntervalMs` between attempts. The package
schedules no more than `(maxPollAttempts - 1) * pollIntervalMs` of polling
delay; RPC and provider request timeouts remain the caller's responsibility.
The package never accepts a private key, selects a source, or accesses
environment variables.

Implementation is tracked in [issue #1](https://github.com/snissn/squid-evm-funding/issues/1).
