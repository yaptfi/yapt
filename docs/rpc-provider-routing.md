# RPC Provider Routing

## Purpose

Yapt routes ordinary RPC reads and historical log scans differently. Historical
`eth_getLogs` calls are more expensive, have provider-specific range limits, and
are more likely to exhaust throughput or daily credits. The scan path therefore
needs capability filtering, pacing, adaptive ranges, and failover.

## Routing architecture

### Normal calls

`getProviderForChain()` returns an `RPCProxyProvider` backed by `RPCManager`.
Normal calls may use every active provider configured for that chain and receive:

- token-bucket rate limiting;
- round-robin distribution;
- health tracking and temporary provider backoff;
- automatic failover when another provider is available;
- configured daily-call accounting.

### Historical scans

Adapters obtain a provider with `getScanCapableProviderForChain(chainId)`. For a
managed chain this is a stable scan-only view of the same `RPCManager`, not a
direct underlying `JsonRpcProvider`.

Every call made through that view—including `getBlockNumber`, fixed-block
contract reads, and `eth_getLogs`—uses only providers with
`supportsLargeBlockScans=true`. It retains the normal queue, rate limiting,
health tracking, and failover behavior.

Do not bypass this path by extracting an underlying provider. Doing so bypasses
configured pacing and makes additional RPC servers ineffective for discovery.

### Transport invariants

Managed providers are created with:

- `batchMaxCount: 1`, because some vendors return an id-less throttle error for
  one item in a JSON-RPC batch; ethers otherwise surfaces the mixed response as
  `BAD_DATA: missing response for request`;
- a pinned static network, because Yapt already knows the chain for each manager
  and does not need repeated `eth_chainId` probes.

These settings are intentional. Preserve them when changing provider creation.

## Capability semantics

The database field is `supports_large_block_scans`; TypeScript and API responses
use `supportsLargeBlockScans`.

Set it to `true` when an endpoint can reliably serve historical `eth_getLogs`.
It does not mean the endpoint accepts unlimited ranges. A provider limited to
10,000 blocks can remain enabled because the Uniswap v4 scanner adapts its range.

Set it to `false` when an endpoint cannot serve the required historical logs.
It will remain available for normal contract reads but will not receive scan
traffic.

The column is added by
`migrations/1733000030000_add-rpc-supports-large-block-scans.js`.

## Uniswap v4 inventory scan

`src/utils/uniswap-v4-inventory.ts` performs one shared inventory scan for all v4
adapters using the same wallet, Position Manager, start block, and provider.

The scanner:

1. Gets one latest block and uses it as the block tag for the inventory read.
2. Reads the wallet's Position Manager `balanceOf` at that block.
3. Returns immediately for a zero balance.
4. Scans incoming NFT `Transfer` events newest-to-oldest.
5. Starts with `UNISWAP_V4_SCAN_CHUNK_SIZE` (default 50,000 blocks).
6. Uses a provider-reported block limit when available; otherwise halves a
   rejected range until accepted.
7. Retries transient throttles with backoff. Error parsing must inspect nested
   ethers fields, including `error`, `info`, `data`, and `value[]`.
8. Deduplicates token IDs and verifies `ownerOf` at the fixed latest block.
9. Stops as soon as the number of verified NFTs equals `balanceOf`.
10. Throws an explicit mismatch if configured history is exhausted first.

Successful inventories are cached for 60 seconds. Terminal scan failures are
cached briefly so sibling adapters do not immediately repeat the same failure.

## Configuration

### Admin UI / database

Each provider row contains a required Ethereum URL and an optional Arbitrum URL.
A row participates in Arbitrum routing only when its Arbitrum URL is present.

For a historical-log provider:

- keep it active;
- supply the URL for every chain it should serve;
- enable **Historical Block Scans**;
- set `callsPerSecond` conservatively and below the vendor quota;
- set `callsPerDay` when the plan has a known daily allowance.

The **Use for Historical Scans** checkbox is an opt-in routing control, not a
provider capability test. Enabling it immediately makes the endpoint eligible
for live `eth_getLogs` requests after the RPC managers reload. New providers
default to unchecked in the admin UI; enable it only after confirming the plan
supports historical logs and setting conservative rate limits.

Creating or editing providers through the admin API reloads the in-process
provider managers automatically.

The admin provider table reports the active historical-scan route count for each
chain. A count of `1` means scans can run but cannot fail over; a count of `2` or
more means scan failover is available. Startup logs report the same count, and a
successful fallback logs the backup provider name without its URL.

### Environment configuration

The equivalent multi-provider variables are:

```dotenv
ETH_RPC_URLS=https://provider-a.example/eth,https://provider-b.example/eth
ETH_RPC_LIMITS=1,1
ETH_RPC_SCAN_CAPABILITIES=true,true

ARBITRUM_RPC_URLS=https://provider-a.example/arb,https://provider-b.example/arb
ARBITRUM_RPC_LIMITS=1,1
ARBITRUM_RPC_SCAN_CAPABILITIES=true,true
```

Active database providers for a chain take precedence over that chain's
environment configuration.

## Reliability recommendations

- Configure at least two independent scan-capable providers per required chain.
- Prefer separate vendor projects or vendors; two URLs sharing one quota do not
  protect against project-level credit exhaustion.
- Start scan-capable endpoints around 1 call/second when the true allowance is
  unknown, then tune from observed provider status and vendor limits.
- Keep range-limited endpoints scan-enabled if they reliably serve historical
  logs; the inventory scanner adapts the range.
- A second provider helps only after it is active for the chain and marked
  scan-capable.

No retry strategy can overcome an exhausted daily/project quota when every
eligible provider shares that quota. Add an independent backup or increase the
quota in that case.

## Troubleshooting

### `RPC block-range limit detected`

This is expected adaptation, not a terminal failure. The warning should appear
once for that inventory scan and must not include an RPC URL or credentials.

### `Too Many Requests`, `-32005`, or all providers rate limited

1. Confirm the deployed scan path uses the managed scan-only provider.
2. Lower `callsPerSecond` for the throttled endpoint.
3. Check its daily/project credit usage.
4. Confirm at least one independent backup has an Arbitrum URL (when relevant),
   is active, and has Historical Block Scans enabled.
5. Inspect provider health in the admin UI, then rescan after configuration is
   reloaded.

### Re-scan appears stuck at `Starting discovery`

The scan endpoint sends an immediate acceptance event and a keep-alive every 15
seconds. If the same wallet is already being scanned, the UI reports that it
joined the in-flight scan and shows the current protocol. Server logs record the
request, stream acceptance, completion or failure, browser disconnects, and the
elapsed time. Protocol-level failures remain fail-soft, but are listed in the
re-scan modal and summarized when discovery completes.

### `BAD_DATA: missing response for request`

If the error contains a mixed response with `Too Many Requests`, first confirm
the deployment includes disabled batching and static network configuration.
The recursive retry classifier still handles this legacy/provider error shape.

### `No scan-capable RPC provider available`

At least one active chain provider must have Historical Block Scans enabled. A
normal-only provider cannot be used as a silent fallback for historical scans.

### Inventory history mismatch

An error such as `found 1 of 2 NFTs reported by balanceOf` means the scanner
reached its configured deployment block without finding every currently owned
NFT. Check the protocol's `deployBlock`, provider historical-log completeness,
and any swallowed/non-retryable `ownerOf` errors before changing the invariant.

## Regression tests

Relevant deterministic tests are:

- `tests/utils/uniswap-v4-inventory.test.ts`—range adaptation, newest-first
  stopping, ownership, retries, production nested error payloads, and failure
  caching;
- `tests/utils/rpc-manager.test.ts`—scan capability filtering, throttled-provider
  failover, batching options, static networks, quota accounting, and low rates;
- `tests/utils/rpc-proxy-provider.test.ts`—stable scan-only provider routing;
- `tests/utils/ethereum.test.ts`—chain initialization and capability selection.

Run `npm run typecheck`, `npm run lint`, and `npm test` after routing changes.
