# RPC Provider-Specific Routing

## Overview

The RPC manager now supports **provider-specific routing** to handle different RPC provider capabilities. This solves the problem of some providers (like Alchemy free tier) having restrictive limits on `eth_getLogs` block ranges while others (like Infura) support large scans.

## The Problem

**Alchemy Free Tier Limitation:**
```
Error: Under the Free tier plan, you can make eth_getLogs requests with
up to a 10 block range.
```

**Why This Matters:**
- Uniswap v4 adapter needs to scan Transfer events to find NFT positions
- Historical scans may need to cover 100k+ blocks
- With 10 block limit: scanning 100k blocks = 10,000 requests
- Alchemy free tier can't handle this, but Infura can

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

**When to set to `false`:**
- Alchemy free tier (10 block limit)
- GetBlock.io free tier (2,000 block limit)
- Any provider with < 10,000 block range limits

**When to set to `true`:**
- Infura (supports 100k+ blocks) - **Recommended for Uniswap discovery**
- QuickNode (enterprise tier)
- Ankr
- Self-hosted nodes
- Most paid RPC services with generous limits

### 2. Database Schema

Migration `1733000030000_add-rpc-supports-large-block-scans.js` adds:

```sql
ALTER TABLE rpc_provider
  ADD COLUMN supports_large_block_scans BOOLEAN NOT NULL DEFAULT true;
```

**Default:** `true` (backwards compatible - assumes providers support large scans)

### 3. RPC Manager API

New method to get scan-capable provider:

```typescript
class RPCManager {
  /**
   * Get a provider that supports large block scans
   * Returns direct ethers provider (not proxied through queue)
   */
  getScanCapableProvider(): ethers.JsonRpcProvider | null {
    const scanCapableProviders = this.providers.filter(
      state => state.config.supportsLargeBlockScans === true && state.isHealthy
    );

    if (scanCapableProviders.length === 0) {
      return null; // No scan-capable providers available
    }

    // Return highest priority scan-capable provider
    return scanCapableProviders[0].provider;
  }
}
```

### 4. Adapter Usage

Uniswap v4 adapter now uses scan-capable provider:

```typescript
async discover(walletAddress: string): Promise<Partial<Position>[]> {
  // Get scan-capable provider
  const proxyProvider = getProvider();
  let scanProvider;

  if ('getRPCManager' in proxyProvider) {
    const manager = proxyProvider.getRPCManager();
    scanProvider = manager.getScanCapableProvider();

    if (!scanProvider) {
      console.warn('[Uniswap v4] No scan-capable RPC provider available');
      return []; // Skip Uniswap discovery
    }
  }

  // Use scan-capable provider for event queries
  const positionManager = new ethers.Contract(
    config.positionManager,
    positionManagerAbi,
    scanProvider // <-- Uses scan-capable provider
  );

  // Query historical Transfer events (may scan millions of blocks)
  const receivedEvents = await positionManager.queryFilter(transferFilter);
  const sentEvents = await positionManager.queryFilter(sentFilter);

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
- Uses highest priority scan-capable provider
- **No automatic failover** (direct provider access, not queued)

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
- Block scans (1% of requests) → Only Infura used (scan-capable)

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
   - Added `getScanCapableProvider()` method

2. **`src/models/rpc-provider.ts`**
   - Updated database row type to include `supports_large_block_scans`
   - Updated all SQL queries to include the column
   - Updated `createRPCProvider()` to handle the flag (defaults to `true`)
   - Updated `updateRPCProvider()` to allow updating the flag

3. **`src/adapters/uniswap-v4.ts`**
   - Updated `discover()` to use scan-capable provider for event queries
   - Added fallback to regular provider for single-provider setups
   - Added warning logs when no scan-capable providers available

4. **`frontend/admin.html`**
   - Added "Supports Large Block Scans" checkbox to add provider form
   - Added "Capabilities" column to provider table showing scan support status
   - Updated JavaScript to include `supportsLargeBlockScans` in form submission

5. **`migrations/1733000030000_add-rpc-supports-large-block-scans.js`**
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

**Cause:** No scan-capable providers available

**Solution:**
- Uniswap requires historical event scanning
- Must have at least one provider with `supportsLargeBlockScans=true`
- Other protocols (Aave, Curve, etc.) don't require scans and will work fine

### All requests going to one provider

**Check:**
1. Is only one provider active?
2. Are other providers unhealthy?
3. For scans: Is only one provider scan-capable?

**This is expected behavior** for scan operations - they ONLY use scan-capable providers.
