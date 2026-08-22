// Read-only repro for "Refreshed Squid route failed execution trust checks".
//
// Plans a Base USDC -> Filecoin USDFC top-up (quoteOnly price quotes), then
// fetches the executable route via quoteSquidRoute with the exact QuoteInput
// executeSquidFunding's internal refresh builds, and evaluates every
// assertQuote clause (src/execution.ts) independently to name the one that
// fails on live quote drift. No transactions, no keys.
//
// Usage: SQUID_INTEGRATOR_ID=... node scripts/repro-trust-check.mjs
import {
  NATIVE_TOKEN_ADDRESS,
  planSquidFunding,
  quoteSquidRoute,
  SQUID_ROUTER_ADDRESS,
} from "../dist/index.js"

const integratorId = process.env.SQUID_INTEGRATOR_ID?.trim()
if (!integratorId) throw new Error("SQUID_INTEGRATOR_ID env required")
const options = { integratorId, fetch: globalThis.fetch }

const BASE = 8453
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const FILECOIN = 314
const USDFC = "0x80B98d3aa09ffff255c3ba4A241111Ff1262F045"
const OWNER = "0xffd636C1f7f8Ec9754f608bc2DCcDcf1BE5D666E" // any funded address; read-only

// --- mirror the private helpers assertQuote depends on (src/execution.ts) ---
const NATIVE_COST_HEADROOM_BPS = 100n
const BASIS_POINTS = 10_000n
const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase()
const native = (token) => sameAddress(token, NATIVE_TOKEN_ADDRESS)
const routeNativeFees = (quote, source) =>
  quote.costs.reduce(
    (total, cost) =>
      total +
      (cost.kind === "fee" &&
      cost.token.chainId === source.chainId &&
      cost.token.address != null &&
      native(cost.token.address)
        ? cost.amount
        : 0n),
    0n,
  )
const routeNativeValue = (quote, source) =>
  (native(source.token) ? quote.sourceAmount : 0n) +
  routeNativeFees(quote, source)
const reviewedNativeValueCap = (quote, source) => {
  const fees = routeNativeFees(quote, source)
  const headroom =
    (fees * NATIVE_COST_HEADROOM_BPS + BASIS_POINTS - 1n) / BASIS_POINTS
  return routeNativeValue(quote, source) + headroom
}

// --- plan (quoteOnly), exactly like the explorer's estimate step ---
const plan = await planSquidFunding(
  {
    owner: OWNER,
    sourceChainId: BASE,
    sourceToken: USDC_BASE,
    requirements: [
      {
        id: "usdfc-topup",
        chainId: FILECOIN,
        token: USDFC,
        amount: 5_000_000_000_000_000_000n, // 5 USDFC target
        recipient: OWNER,
      },
    ],
    maxSourceAmount: "20", // USDC cap; planner searches below it
    slippage: 1,
  },
  options,
)
const planned = plan.quotes[0]
const source = plan.source
console.log("planned:", {
  sourceAmount: planned.sourceAmount,
  destinationAmount: planned.destinationAmount,
  nativeFees: routeNativeFees(planned, source),
  reviewedNativeValueCap: reviewedNativeValueCap(planned, source),
  costs: planned.costs.map(
    (c) =>
      `${c.kind}:${c.name}@${c.token.chainId} ${c.amount} ${c.token.symbol}`,
  ),
})

// --- refresh the executable route once, ~2s later, exactly like the
// `refresh` closure in executeSquidFunding does ---
await new Promise((r) => setTimeout(r, 2000))
const refreshed = await quoteSquidRoute(
  {
    owner: plan.owner,
    source: plan.source,
    requirement: planned.requirement,
    sourceAmount: planned.sourceAmount,
    slippage: plan.slippage,
  },
  options,
)
console.log("refreshed:", {
  sourceAmount: refreshed.sourceAmount,
  destinationAmount: refreshed.destinationAmount,
  value: refreshed.value,
  nativeFees: routeNativeFees(refreshed, source),
  routeNativeValue: routeNativeValue(refreshed, source),
  expiresAt: refreshed.expiresAt,
  target: refreshed.target,
  approvalSpender: refreshed.approvalSpender,
  costs: refreshed.costs.map(
    (c) =>
      `${c.kind}:${c.name}@${c.token.chainId} ${c.amount} ${c.token.symbol}`,
  ),
})

// --- evaluate every assertQuote clause independently (order and semantics
// mirror src/execution.ts assertQuote; trusted target/spender are what the
// explorer passes: SQUID_ROUTER_ADDRESS for both) ---
const now = Math.floor(Date.now() / 1000)
const target = SQUID_ROUTER_ADDRESS
const spender = SQUID_ROUTER_ADDRESS
const clauses = {
  requirementIdChanged: refreshed.requirement.id !== planned.requirement.id,
  sourceAmountDrift: refreshed.sourceAmount !== planned.sourceAmount,
  requirementChainChanged:
    refreshed.requirement.chainId !== planned.requirement.chainId,
  requirementTokenChanged: !sameAddress(
    refreshed.requirement.token,
    planned.requirement.token,
  ),
  requirementRecipientChanged: !sameAddress(
    refreshed.requirement.recipient,
    planned.requirement.recipient,
  ),
  destinationBelowRequirement:
    refreshed.destinationAmount < planned.requirement.amount,
  emptyRouteId: refreshed.id.trim() === "",
  targetMismatch: !sameAddress(refreshed.target, target),
  missingApprovalSpender:
    !native(source.token) && refreshed.approvalSpender == null,
  spenderMismatch:
    refreshed.approvalSpender != null &&
    !sameAddress(refreshed.approvalSpender, spender),
  badCalldata: !/^0x(?:[0-9a-fA-F]{2})+$/.test(refreshed.data),
  expiresAtUnsafe: !Number.isSafeInteger(refreshed.expiresAt),
  expiresInPast: refreshed.expiresAt <= now,
  valueInternalInconsistent:
    refreshed.value !== routeNativeValue(refreshed, source),
  valueAboveReviewedCap:
    refreshed.value > reviewedNativeValueCap(planned, source),
}
console.table(
  Object.entries(clauses).map(([clause, fails]) => ({ clause, fails })),
)
const failing = Object.entries(clauses)
  .filter(([, fails]) => fails)
  .map(([clause]) => clause)
console.log(
  failing.length === 0
    ? "assertQuote would PASS on this pair"
    : `assertQuote would THROW; failing clause(s): ${failing.join(", ")}`,
)
