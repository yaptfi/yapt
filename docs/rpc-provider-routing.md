# RPC Provider-Specific Routing

## Overview

The RPC manager supports **provider-specific routing** for historical
`eth_getLogs` calls. Providers may impose different block-range, throughput,
and daily-credit limits, so discovery adapts its range and can fail over.

## The Problem

**Example provider limitation:**
```
Error: Under the Free tier plan, you can make eth_getLogs requests with
up to a 10 block range.
```

**Why This Matters:**
- Uniswap v4 adapter needs to scan Transfer events to find NFT positions
- Historical scans may need to cover 100k+ blocks
- With a 10 block limit: scanning 100k blocks = 10,000 requests
- Range adaptation alone does not solve throughput or daily-credit exhaustion

## Solution: Capability-Based Routing

### 1. Provider Configuration

Each RPC provider now has a `supportsLargeBlockScans` flag:

```typescript
interface RPCProviderConfig {
  id?: number;
  name: string;
  url: string;
  callsPerSecond: number;
  callsPerDay?: number;
  priority: number;
  isActive: boolean;
  supportsLargeBlockScans?: boolean; // NEW!
}
```

Set the flag to `true` when the endpoint supports historical `eth_getLogs`.
The scanner automatically reduces rejected ranges, including 10,000-block
limits. Set it to `false` only when the endpoint cannot reliably serve
historical logs; those providers remain available for normal contract reads.

### 2. Database Schema

Migration `1733000030000_add-rpc-supports-large-block-scans.js` adds:

```sql
ALTER TABLE rpc_provider
  ADD COLUMN supports_large_block_scans BOOLEAN NOT NULL DEFAULT true;
```

**Default:** `true` (backwards compatible - assumes providers support large scans)

### 3. RPC Manager API

Scan calls use a dedicated managed queue:

```typescript
class RPCManager {
  sendScan(method: string, params: unknown[]): Promise<unknown>;
  hasScanCapableProviders(): boolean;
}
```

`sendScan()` uses only providers with `supportsLargeBlockScans=true`, while
retaining token-bucket pacing, health tracking, and automatic failover.

### 4. Adapter Usage

Uniswap v4 adapter now uses scan-capable provider:

```typescript
async discover(walletAddress: string): Promise<Partial<Position>[]> {
  const scanProvider = getScanCapableProviderForChain(config.chainId);
  if (!scanProvider) {
    console.warn('[Uniswap v4] No scan-capable RPC provider available');
    return [];
  }

  // Use scan-capable provider for event queries
  const positionManager = new ethers.Contract(
    config.positionManager,
    positionManagerAbi,
    scanProvider // <-- Uses scan-capable provider
  );

  // The shared inventory scanner walks backward in adaptive chunks.
  const inventory = await getWalletUniswapV4Inventory(/* ... */);

  // ... rest of discovery logic
}
```

## Admin UI

### Adding Providers

Form includes checkbox for "Supports Large Block Scans":

```html
<input type="checkbox" id="providerSupportsLargeScans" checked>
<label>Supports Large Block Scans</label>
<div>Uncheck for Alchemy free tier (10 block limit).
     Keep checked for Infura/QuickNode.</div>
```

### Provider Table

Shows capability status:

| Name | URL | Capabilities | Status |
|------|-----|--------------|--------|
| Infura | https://mainnet.infura... | ✓ Block Scans | Healthy |
| Alchemy | https://eth-mainnet.g.alch... | ⚠ Limited Scans | Healthy |

## Behavior

### Normal RPC Calls (balance checks, contract calls)

**Load balanced across ALL providers** (regardless of `supportsLargeBlockScans`):
- Round-robin selection
- Rate limiting via token buckets
- Automatic failover on errors

### Block Scanning Calls (eth_getLogs, queryFilter)

**Routed ONLY to scan-capable providers**:
- Filters to providers with `supportsLargeBlockScans=true`
- Uses the RPC manager's token-bucket pacing
- Load balances and fails over across all healthy scan-capable providers
- Disables ethers request batching to isolate provider throttle responses
- Pins the configured chain to avoid redundant `eth_chainId` probes

### Graceful Degradation

If no scan-capable providers available:
```typescript
if (!scanProvider) {
  console.warn('[Uniswap v4] No scan-capable RPC provider available');
  console.warn('[Uniswap v4] Configure an RPC provider with supportsLargeBlockScans=true');
  return []; // Skip protocol discovery
}
```

## Configuration Examples

### Infura + Alchemy Setup

**Infura (scan-capable, low priority for normal calls):**
```json
{
  "name": "Infura",
  "url": "https://mainnet.infura.io/v3/YOUR_KEY",
  "callsPerSecond": 10,
  "priority": 0,
  "isActive": true,
  "supportsLargeBlockScans": true
}
```

**Alchemy (fast for normal calls, skip for scans):**
```json
{
  "name": "Alchemy",
  "url": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
  "callsPerSecond": 25,
  "priority": 10,
  "isActive": true,
  "supportsLargeBlockScans": false  // <-- Free tier: 10 block limit
}
```

**Result:**
- Normal calls (99% of requests) → Load balanced, Alchemy preferred (higher priority)
- Block scans (1% of requests) → Only Infura used because it is the only provider marked scan-capable

To provide scan failover, configure at least two independent providers with
`supportsLargeBlockScans=true` and conservative `callsPerSecond` values.

### Single Provider Setup

If you only have one provider, the system degrades gracefully:

**Infura only:**
- ✅ Normal calls work
- ✅ Block scans work
- ✅ Uniswap discovery works

**Alchemy free tier only:**
- ✅ Normal calls work
- ❌ Block scans fail (10 block limit)
- ❌ Uniswap discovery skipped (warns in logs)

## Files Modified

1. **`src/utils/rpc-manager.ts`**
   - Added `supportsLargeBlockScans` to `RPCProviderConfig`
   - Added rate-limited, failover-aware `sendScan()` routing

2. **`src/utils/rpc-proxy-provider.ts`**
   - Added a stable scan-only provider view backed by the RPC manager

3. **`src/models/rpc-provider.ts`**
   - Updated database row type to include `supports_large_block_scans`
   - Updated all SQL queries to include the column
   - Updated `createRPCProvider()` to handle the flag (defaults to `true`)
   - Updated `updateRPCProvider()` to allow updating the flag

4. **`src/adapters/uniswap-v4.ts`**
   - Updated `discover()` to use scan-capable provider for event queries
   - Added fallback to regular provider for single-provider setups
   - Added warning logs when no scan-capable providers available

5. **`frontend/admin.html`**
   - Added "Supports Large Block Scans" checkbox to add provider form
   - Added "Capabilities" column to provider table showing scan support status
   - Updated JavaScript to include `supportsLargeBlockScans` in form submission

6. **`migrations/1733000030000_add-rpc-supports-large-block-scans.js`**
   - New migration adding `supports_large_block_scans` column
   - Defaults to `true` for backwards compatibility

## Benefits

### Performance
- **Fast providers for common calls**: Alchemy handles 99% of requests (higher priority)
- **Capable providers for heavy lifting**: Infura handles 1% of scans that need large block ranges

### Cost Optimization
- Use free tiers for different purposes
- Alchemy free: Fast, high rate limit, but restricted scans
- Infura free: Generous block scan limits

### Reliability
- System gracefully skips protocols that require scans if no capable providers available
- Clear warnings in logs guide configuration

### Flexibility
- Can mix and match providers based on their strengths
- New providers can specify capabilities via single boolean flag

## Future Extensions

This pattern can be extended for other provider-specific capabilities:

```typescript
interface RPCProviderConfig {
  // Existing
  supportsLargeBlockScans?: boolean;

  // Potential future additions
  supportsTraceApi?: boolean;           // trace_* methods
  supportsDebugApi?: boolean;           // debug_* methods
  supportsArchiveData?: boolean;        // Historical state queries
  supportsWebSocket?: boolean;          // WebSocket subscriptions
  supportsEIP1559?: boolean;            // Type 2 transactions
}
```

Then add routing methods:

```typescript
getTraceCapableProvider(): ethers.JsonRpcProvider | null;
getArchiveCapableProvider(): ethers.JsonRpcProvider | null;
getWebSocketProvider(): ethers.WebSocketProvider | null;
```

## Testing

To verify the routing is working:

1. **Add Alchemy with `supportsLargeBlockScans=false`:**
   ```bash
   # Via admin UI or database
   UPDATE rpc_provider SET supports_large_block_scans = false WHERE name = 'Alchemy';
   ```

2. **Add Infura with `supportsLargeBlockScans=true`:**
   ```bash
   # Already defaults to true
   ```

3. **Trigger discovery:**
   ```bash
   # Watch logs
   docker compose logs app --follow
   ```

4. **Expected behavior:**
   - Normal balance checks → Load balanced between both providers
   - Uniswap discovery → Only uses Infura
   - No "10 block range" errors

## Troubleshooting

### "No scan-capable RPC provider available"

**Cause:** All providers have `supportsLargeBlockScans=false` or are unhealthy

**Solution:**
1. Check provider status in admin UI
2. Update at least one provider to have `supportsLargeBlockScans=true`
3. Or add a new provider that supports large scans (Infura, QuickNode, etc.)

### Uniswap positions not discovered

**Cause:** No scan-capable providers are configured, or all configured scan
providers are temporarily unhealthy or quota-limited.

**Solution:**
- Uniswap requires historical event scanning
- Must have at least one provider with `supportsLargeBlockScans=true`
- Other protocols (Aave, Curve, etc.) don't require scans and will work fine

### All requests going to one provider

**Check:**
1. Is only one provider active?
2. Are other providers unhealthy?
3. For scans: Is only one provider scan-capable?

Scan operations only use scan-capable providers. Configure at least two such
providers if discovery must continue through a single-provider outage or throttle.
