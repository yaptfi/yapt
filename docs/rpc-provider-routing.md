# RPC Provider Routing

## Purpose

Yapt routes ordinary RPC reads and full-history log scans differently. Uniswap
v4 inventory discovery is deliberately incremental and uses the normal managed
provider path; it no longer requires replaying Position Manager logs from the
deployment block.

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
contract reads, and `eth_getLogs`—uses only providers whose probe-derived scan
flag is enabled for that chain. At runtime this is exposed to the manager as
`supportsLargeBlockScans=true`. It retains the normal queue, rate limiting,
health tracking, and failover behavior.

Do not bypass this path by extracting an underlying provider. Doing so bypasses
configured pacing and makes additional RPC servers ineffective for discovery.

This scan-only path remains for adapters that genuinely need a full historical
log walk. Uniswap v4 is not one of them: its persisted inventory, sequential
token-ID batches, and short incremental transfer scan use
`getProviderForChain()` so every healthy chain provider can contribute. An
endpoint's full-history scan flag therefore does not determine whether it can
participate in Uniswap v4 discovery.

### Transport invariants

Managed providers are created with:

- `batchMaxCount: 1`, because some vendors return an id-less throttle error for
  one item in a JSON-RPC batch; ethers otherwise surfaces the mixed response as
  `BAD_DATA: missing response for request`;
- a pinned static network, because Yapt already knows the chain for each manager
  and does not need repeated `eth_chainId` probes.

These settings are intentional. Preserve them when changing provider creation.

## Capability semantics

Database-managed providers store independent
`supports_ethereum_block_scans` and `supports_arbitrum_block_scans` fields.
`supports_large_block_scans` remains as a legacy aggregate. The model maps the
correct per-chain value to `supportsLargeBlockScans` when it builds each chain's
RPC manager.

Do not set database scan flags manually. The admin capability probe sets them
after it verifies the endpoint. These flags mean the endpoint can handle an
adapter's full historical log workload within the configured query budget; they
do not mean that Uniswap v4 needs a full-history scan.

An endpoint that passes ordinary chain reads but cannot serve a useful
historical-log range remains available for normal contract reads but does not
receive scan traffic. A throttle, timeout, or network failure is inconclusive:
the last conclusive routing flag is retained and the UI asks the administrator
to retry.

Per-chain flags and sanitized probe results are added by
`migrations/1733000057000_add-rpc-provider-probe-results.js`.

## Capability and health checks

The admin page shows two different signals:

- **Runtime state** is passive RPCManager telemetry. A provider starts without
  error history, becomes degraded after repeated live-call failures, and
  recovers after backoff plus a successful request. This is not a connectivity
  test.
- **Verified capabilities** are active, direct JSON-RPC probes. Each configured
  chain checks `eth_chainId`, `eth_blockNumber`, a Uniswap v4 `nextTokenId()`
  state read, and a real `eth_getLogs` query against the Position Manager.

The log probe starts at 500,000 blocks. If the endpoint reports a range limit,
the probe retries at that limit; otherwise it halves recognized range-rejection
failures. A working range of at least 1,000 blocks qualifies for incremental
Uniswap v4 transfer checks. Full-history routing is reported separately and is
enabled only when the chain's full relevant history fits within the configured
500-query budget. Thus a 6,250-block Arbitrum endpoint is useful for v4 even
though the UI leaves its other full-history routing disabled.
Probe records include the check time, latency, sanitized status, and detected
range, but never the endpoint URL or API key.

The admin page automatically refreshes missing or older-than-six-hours probes
while it is open. **Retest saved** performs the same check immediately. These checks
run directly against the provider being tested, so load balancing cannot hide a
broken or misconfigured endpoint.

For an existing provider, **Edit & test** opens the same wizard with the saved
name, complete URLs, API-key portions, and limits prefilled. The endpoints remain
editable. A fresh capability check is required before **Save Verified Provider**
appears, and saving re-runs the checks server-side before changing the row.

## Uniswap v4 inventory scan

`src/utils/uniswap-v4-inventory.ts` performs one shared inventory discovery for
all v4 adapters using the same wallet, chain, Position Manager, and provider.
Verified inventory and progress are stored in
`uniswap_v4_inventory_state` (migration
`1733000058000_add-uniswap-v4-inventory-state.js`). Existing active positions
seed this state on the first run after migration.

The scanner:

1. Gets one latest block and uses it as the block tag for all ownership reads.
2. Loads checkpointed token IDs plus active-position metadata and verifies each
   with `ownerOf`.
3. Reads `balanceOf` and `nextTokenId()` at the fixed block. A zero balance is a
   complete result and performs no enumeration or log scan.
4. If new Position Manager IDs exist, checks those IDs newest-first through
   Multicall3 ownership batches (500 IDs by default). A newly minted position is
   normally found in one call even on fast-block chains.
5. If ownership changed without minting, scans only incoming transfers since
   the last complete checkpoint. Provider-reported block limits such as 6,250
   are accepted; otherwise a rejected range is halved.
6. For an unseeded wallet or unresolved old transfer, performs a bounded
   newest-first token-ID scan and persists its cursor. The next re-scan resumes
   instead of starting over.
7. Deduplicates IDs and stops as soon as the verified count equals `balanceOf`.
8. Enforces a combined 500-query/10-minute budget by default. If the budget or
   a provider fails after some NFTs were verified, those positions are returned
   and progress is saved. A run throws only when it cannot verify any usable
   inventory.

In-flight inventory promises never expire, so every sibling v4 adapter joins
the same long-running scan. Successful inventories are cached for 60 seconds
after completion. Terminal failures are cached for five minutes to prevent the
next adapter from immediately repeating hundreds of requests.

The safety limits can be overridden deliberately with
`UNISWAP_V4_MAX_LOG_QUERIES` (a legacy name that now covers both bounded
ownership batches and log queries), `UNISWAP_V4_SCAN_TIMEOUT_MS`,
`UNISWAP_V4_OWNER_BATCH_SIZE`, `UNISWAP_V4_RECENT_TOKEN_WINDOW`, and
`UNISWAP_V4_RECENT_SCAN_BLOCKS`. Raising them is usually the wrong fix because
normal progress is resumable.

## Configuration

### Admin UI / database

Each provider row contains a required Ethereum URL and an optional Arbitrum URL.
A row participates in Arbitrum routing only when its Arbitrum URL is present.

Use the **Add RPC Provider Wizard**:

1. Enter a provider name and its Ethereum URL. Put the API key in the URL in the
   format supplied by the vendor.
2. Optionally enter the matching Arbitrum URL. An Ethereum endpoint cannot serve
   Arbitrum unless that separate URL is present.
3. Set conservative local rate and daily limits.
4. Select **Test URLs & Detect Capabilities**. Read the per-chain connectivity
   plus the v4 incremental and other full-history results.
5. If a check fails or is throttled, edit the URL and retry. **Add Verified
   Provider** appears only after every configured endpoint has a conclusive
   result.

Saving re-runs the checks server-side, then enables other full-history routing
only on the chains that passed. A range-limited provider can still be saved and
used for normal reads and incremental Uniswap v4 discovery.

Creating or editing providers through the admin API reloads the in-process
provider managers automatically. Editing an existing Arbitrum URL also probes
the changed endpoint before saving it.

The admin provider table reports the active full-history scan route count for
each chain. This count does not include normal providers available to Uniswap
v4. Startup logs report the same full-history count, and a successful fallback
logs the backup provider name without its URL.

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

- Configure at least two independent normal providers per required chain when
  reliability matters. They need not support large block ranges for v4.
- Prefer separate vendor projects or vendors; two URLs sharing one quota do not
  protect against project-level credit exhaustion.
- Start endpoints around 1 call/second when the true allowance is
  unknown, then tune from observed provider status and vendor limits.
- Keep range-limited endpoints active if they reliably serve state calls and
  incremental logs; the v4 inventory scanner adapts the range.
- A second provider helps v4 as soon as it is active on the chain. A passed
  full-history probe is required only for adapters routed through the scan-only
  provider path.

No retry strategy can overcome an exhausted daily/project quota when every
eligible provider shares that quota. Add an independent backup or increase the
quota in that case.

## Troubleshooting

### `RPC block-range limit detected`

This is expected adaptation, not a terminal failure. The warning should appear
once for that inventory scan and must not include an RPC URL or credentials.

### `Too Many Requests`, `-32005`, or all providers rate limited

1. Confirm the deployed v4 path uses the normal managed chain provider.
2. Lower `callsPerSecond` for the throttled endpoint.
3. Check its daily/project credit usage.
4. Confirm at least one independent backup has an Arbitrum URL (when relevant),
   is active, and shows **Incremental Uniswap v4: supported** after a recent
   capability test.
5. Use **Retest saved** or **Edit & test** in the admin UI. This distinguishes a bad key/wrong chain,
   transient throttle, and unsupported historical range before another wallet
   re-scan is attempted.

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

This message now concerns an adapter that still requires a genuine full-history
scan; it should not be emitted by Uniswap v4 discovery. V4 uses active normal
providers and its own bounded, resumable inventory state.

### Incomplete inventory

`Inventory discovery is incomplete` means the bounded run could not yet verify
all NFTs reported by `balanceOf`. Verified positions are retained, and a cold
cursor is saved for the next run. Check provider state-call health and re-scan;
do not increase the budget merely because Arbitrum has many blocks.

## Regression tests

Relevant deterministic tests are:

- `tests/utils/uniswap-v4-inventory.test.ts`—persisted seeds, batched token-ID
  discovery, incremental range adaptation, partial results, resumable cursors,
  ownership retries, and shared caching;
- `tests/utils/rpc-manager.test.ts`—scan capability filtering, throttled-provider
  failover, batching options, static networks, quota accounting, and low rates;
- `tests/utils/rpc-proxy-provider.test.ts`—stable scan-only provider routing;
- `tests/utils/ethereum.test.ts`—chain initialization and capability selection.
- `tests/services/rpc-provider-probe.test.ts`—chain validation, v4 state reads,
  full and range-limited logs (including 6,250 blocks), throttling, and unusably
  small ranges;
- `tests/routes/admin.rpc-providers.contract.test.ts`—wizard, re-probe, and
  probe-derived routing contracts.

Run `npm run typecheck`, `npm run lint`, and `npm test` after routing changes.
