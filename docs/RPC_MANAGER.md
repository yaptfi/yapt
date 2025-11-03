# RPC Manager Documentation

## Overview

The RPC Manager system provides intelligent load balancing, rate limiting, and automatic failover across multiple Ethereum RPC providers. It transparently replaces the single provider setup with minimal code changes.

## Architecture

### Components

1. **RPCManager** (`src/utils/rpc-manager.ts`)
   - Token bucket rate limiting per provider
   - Round-robin load balancing
   - Automatic failover on errors
   - Health tracking with exponential backoff
   - Call queue management

2. **RPCProxyProvider** (`src/utils/rpc-proxy-provider.ts`)
   - Extends `ethers.JsonRpcProvider`
   - Transparent drop-in replacement
   - Routes all calls through RPCManager

3. **Database Model** (`src/models/rpc-provider.ts`)
   - CRUD operations for `rpc_provider` table
   - Manages provider configurations at runtime

## Configuration Options

### Option 1: Single Provider (Simple)

**Backward compatible** - uses existing `ETH_RPC_URL`:

```bash
ETH_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
```

### Option 2: Multiple Providers via Environment Variables

Add to your `.env` file:

```bash
# Multiple providers (comma-separated)
ETH_RPC_URLS=https://mainnet.infura.io/v3/KEY1,https://eth.llamarpc.com,https://rpc.ankr.com/eth

# Rate limits per provider (calls per second)
ETH_RPC_LIMITS=10,5,8
```

**Notes:**
- First URL gets highest priority
- If `ETH_RPC_LIMITS` is omitted, defaults to 10 calls/sec per provider
- Mismatched lengths will show a warning and use defaults

### Option 3: Database-Managed Providers (Enterprise)

1. **Run the migration:**
   ```bash
   npm run migrate
   ```

2. **Insert providers via SQL:**
   ```sql
   INSERT INTO rpc_provider (name, url, calls_per_second, calls_per_day, priority, is_active)
   VALUES
     ('Infura Primary', 'https://mainnet.infura.io/v3/KEY1', 25, 100000, 100, true),
     ('Alchemy Backup', 'https://eth-mainnet.g.alchemy.com/v2/KEY2', 15, 50000, 50, true),
     ('Public RPC', 'https://eth.llamarpc.com', 5, NULL, 10, true);
   ```

3. **Manage at runtime via API** (see below)

**Priority:**
1. Database (if providers exist)
2. Environment variables (`ETH_RPC_URLS`)
3. Single provider fallback (`ETH_RPC_URL`)

## Database Schema

```sql
CREATE TABLE rpc_provider (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  calls_per_second NUMERIC(10,2) NOT NULL DEFAULT 10,
  calls_per_day INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Fields

- **name**: Human-readable identifier
- **url**: Full RPC endpoint URL
- **calls_per_second**: Rate limit (supports decimals, e.g., 0.5 = one call every 2 seconds)
- **calls_per_day**: Optional daily quota (resets at midnight UTC)
- **priority**: Higher values = preferred (used for sorting)
- **is_active**: Enable/disable without deletion

## Features

### 1. Token Bucket Rate Limiting

- **Per-provider** rate limits enforced independently
- **Burst capacity**: 2x the per-second limit (e.g., 10 cps = 20 token bucket)
- **Smooth traffic**: Tokens refill continuously, not in discrete intervals

**Example:** 10 calls/second provider
- Can burst 20 calls instantly
- Refills at 10 tokens/second
- After burst, waits for tokens to accumulate

### 2. Automatic Load Balancing

- **Round-robin** distribution across healthy providers
- **Priority-aware**: Higher priority providers attempted first
- **Health-based**: Skips degraded providers automatically

### 3. Failover & Health Tracking

- **Automatic retry**: Failures trigger next provider immediately
- **Error backoff**: 3 consecutive errors → 1 minute cooldown
- **Auto-recovery**: Provider marked healthy after successful call post-backoff
- **Non-retryable errors**: Invalid params/gas errors fail immediately (no retry)

### 4. Daily Quotas

- Optional `calls_per_day` limit per provider
- Resets at midnight UTC
- Tracked in-memory (not persisted)

### 5. Queue Management

- **Max queue size**: 1000 calls (configurable)
- **FIFO processing**: Oldest calls processed first
- **Overflow protection**: Rejects new calls when queue full

## Usage Examples

### Basic Usage (Zero Code Changes)

All existing code continues to work:

```typescript
import { getProvider } from './utils/ethereum';

const provider = getProvider();
const blockNumber = await provider.getBlockNumber();
```

The RPC manager handles everything transparently.

### Monitoring RPC Status

```typescript
import { getRPCStatus } from './utils/ethereum';

const status = getRPCStatus();

console.log('Providers:', status.providers);
// [
//   {
//     name: 'Infura Primary',
//     priority: 100,
//     callsPerSecond: 25,
//     dailyCallCount: 1547,
//     availableTokens: 18.3,
//     consecutiveErrors: 0,
//     isHealthy: true,
//     nextTokenIn: 0
//   },
//   ...
// ]

console.log('Queue:', status.queue);
// { queueLength: 0, maxQueueSize: 1000, isProcessing: false }
```

### Reloading Providers at Runtime

After adding/removing providers in the database:

```typescript
import { reloadRPCProviders } from './utils/ethereum';

await reloadRPCProviders();
console.log('Providers reloaded from database');
```

### Adding Providers Programmatically

```typescript
import { createRPCProvider } from './models/rpc-provider';
import { reloadRPCProviders } from './utils/ethereum';

await createRPCProvider({
  name: 'New Provider',
  url: 'https://new-rpc.example.com',
  callsPerSecond: 20,
  priority: 75,
  isActive: true,
});

await reloadRPCProviders();
```

## API Endpoints (Optional)

You can add management endpoints to your Fastify server:

```typescript
// GET /api/rpc/status
fastify.get('/api/rpc/status', async (request, reply) => {
  const status = getRPCStatus();
  return status || { error: 'RPC manager not initialized' };
});

// POST /api/rpc/reload
fastify.post('/api/rpc/reload', async (request, reply) => {
  await reloadRPCProviders();
  return { success: true, message: 'Providers reloaded' };
});

// POST /api/rpc/providers
fastify.post('/api/rpc/providers', async (request, reply) => {
  const { name, url, callsPerSecond, priority } = request.body;

  const provider = await createRPCProvider({
    name,
    url,
    callsPerSecond,
    priority: priority || 0,
    isActive: true,
  });

  await reloadRPCProviders();
  return provider;
});
```

## Testing

### 1. Test Migration

```bash
# Run migration
DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate

# Verify table created
psql $DATABASE_URL -c "SELECT * FROM rpc_provider;"
```

### 2. Test Single Provider Mode

```bash
# Use existing ETH_RPC_URL
npm run dev

# Check logs for:
# [Ethereum] Initialized with single RPC provider from ETH_RPC_URL
```

### 3. Test Multiple Providers (Environment)

```bash
# Add to .env:
ETH_RPC_URLS=https://mainnet.infura.io/v3/KEY1,https://eth.llamarpc.com
ETH_RPC_LIMITS=10,5

npm run dev

# Check logs for:
# [Ethereum] Initialized with 2 RPC provider(s) from environment
# [RPCManager] Initialized with 2 provider(s)
```

### 4. Test Database-Managed Providers

```sql
-- Insert test providers
INSERT INTO rpc_provider (name, url, calls_per_second, priority, is_active)
VALUES
  ('Test Provider 1', 'https://mainnet.infura.io/v3/KEY', 10, 100, true),
  ('Test Provider 2', 'https://eth.llamarpc.com', 5, 50, true);
```

```bash
npm run dev

# Check logs for:
# [Ethereum] Initialized with 2 RPC provider(s) from database
```

### 5. Test Rate Limiting

Create a test script:

```typescript
// scripts/test-rpc-rate-limit.ts
import { getProvider } from '../src/utils/ethereum';

async function testRateLimit() {
  const provider = getProvider();
  const startTime = Date.now();

  // Make 30 rapid calls
  const promises = Array(30).fill(null).map(() =>
    provider.getBlockNumber()
  );

  await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  console.log(`30 calls completed in ${elapsed}ms`);
  console.log(`Average: ${(elapsed / 30).toFixed(2)}ms per call`);

  // With 10 calls/sec limit, should take ~3 seconds
  // With multiple providers, should be faster
}

testRateLimit();
```

```bash
npx tsx scripts/test-rpc-rate-limit.ts
```

### 6. Test Failover

Temporarily disable one provider:

```sql
UPDATE rpc_provider SET is_active = false WHERE id = 1;
```

Then reload and verify other providers still work:

```bash
# In your app logs, you should see:
# [RPCManager] Provider "..." marked unhealthy after 3 consecutive errors
# [RPCManager] Retrying with next provider
```

## Monitoring & Troubleshooting

### Check Provider Health

```typescript
const status = getRPCStatus();
status.providers.forEach(p => {
  console.log(`${p.name}:`, {
    healthy: p.isHealthy,
    errors: p.consecutiveErrors,
    tokens: p.availableTokens.toFixed(1),
    dailyCalls: p.dailyCallCount
  });
});
```

### Common Issues

**Issue:** All providers showing unhealthy
- **Cause:** Invalid RPC URLs or network issues
- **Fix:** Verify URLs work with `curl`, check firewall

**Issue:** Rate limit errors despite configuration
- **Cause:** Daily quota exceeded
- **Fix:** Check `dailyCallCount` vs `callsPerDay`, increase limit or add providers

**Issue:** High queue length
- **Cause:** RPC calls faster than provider capacity
- **Fix:** Increase `callsPerSecond` or add more providers

**Issue:** "Database not available" warning
- **Cause:** Migration not run or DB connection failed
- **Fix:** Run `npm run migrate`, check `DATABASE_URL`

## Performance Considerations

### Optimal Configuration

**For development:**
```bash
# Single provider, simple
ETH_RPC_URL=https://mainnet.infura.io/v3/KEY
```

**For production (light load):**
```bash
# 2-3 providers with staggered limits
ETH_RPC_URLS=provider1,provider2
ETH_RPC_LIMITS=10,5
```

**For production (heavy load):**
- Use database-managed providers
- 5+ providers with mixed tiers (paid + free)
- Set appropriate daily quotas
- Monitor via `/api/rpc/status` endpoint

### Rate Limit Guidelines

- **Paid RPC providers** (Infura/Alchemy): 25-50 calls/sec
- **Public RPCs**: 5-10 calls/sec
- **Priority**: Paid > Public

### Memory Usage

- **Minimal overhead**: ~1KB per provider
- **Queue**: ~100 bytes per queued call
- **Max memory** (1000 queue): ~100KB

## Migration Guide

### From Single Provider

**Before:**
```typescript
import { getProvider } from './utils/ethereum';
const provider = getProvider(); // Uses ETH_RPC_URL
```

**After:**
```typescript
import { getProvider } from './utils/ethereum';
const provider = getProvider(); // Automatically uses RPC manager
```

No code changes required! Just add multiple providers via env/database.

### Backward Compatibility

- ✅ Existing `ETH_RPC_URL` still works
- ✅ `rpcThrottle()` calls are no-ops (safe to keep)
- ✅ All ethers.js APIs work identically
- ✅ Contracts, multicall, everything unchanged

## Advanced Features

### Custom Queue Size

```typescript
import { createManagedProvider } from './utils/rpc-proxy-provider';

const provider = createManagedProvider(configs, {
  maxQueueSize: 5000, // Increase from default 1000
});
```

### Dynamic Priority Adjustment

```typescript
import { updateRPCProvider } from './models/rpc-provider';

// Boost priority during off-peak hours
await updateRPCProvider(providerId, { priority: 200 });
await reloadRPCProviders();
```

### Temporary Provider Disable

```typescript
import { setRPCProviderActive } from './models/rpc-provider';

// Disable for maintenance
await setRPCProviderActive(providerId, false);
await reloadRPCProviders();

// Re-enable later
await setRPCProviderActive(providerId, true);
await reloadRPCProviders();
```

## Future Enhancements

Potential improvements for future versions:

1. **Latency-based routing**: Track response times, prefer faster providers
2. **Cost optimization**: Route to cheaper providers when possible
3. **Persistent daily counters**: Store in Redis for multi-instance setups
4. **Provider metrics**: Track success rate, avg latency, total calls
5. **Webhook notifications**: Alert on provider failures
6. **Auto-scaling**: Dynamically adjust rate limits based on observed errors

## Support

For issues or questions:
- Check logs for `[Ethereum]` and `[RPCManager]` prefixes
- Run `getRPCStatus()` to inspect provider state
- Verify database migration with `SELECT * FROM rpc_provider`
- Test single provider first, then add multiple
