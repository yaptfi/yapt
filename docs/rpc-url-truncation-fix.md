# RPC URL Truncation Bug Fix

## Issue

Both Alchemy and Infura RPC provider URLs were being truncated to 50 characters, causing authentication failures with errors like:

```
server response 401 Unauthorized: invalid project id
```

**Root Cause**: The `RPCProxyProvider` constructor was calling `rpcManager.getStatus()[0]?.url` to initialize the parent `JsonRpcProvider` class. The `getStatus()` method is designed for display/monitoring purposes and intentionally truncates URLs to 50 characters.

## Solution

Added a new method `getConfigs()` to `RPCManager` class that returns full provider configurations without any truncation:

```typescript
/**
 * Get configs of all providers (full URLs, no truncation)
 */
getConfigs(): RPCProviderConfig[] {
  return this.providers.map(state => state.config);
}
```

Updated `RPCProxyProvider` constructor to use `getConfigs()` instead of `getStatus()`:

```typescript
// BEFORE (buggy):
const firstProviderUrl = rpcManager.getStatus()[0]?.url || 'http://localhost';

// AFTER (fixed):
const firstProviderUrl = rpcManager.getConfigs()[0]?.url || 'http://localhost';
```

## Files Modified

1. **src/utils/rpc-manager.ts** (line ~414)
   - Added `getConfigs()` method returning full configs
   - Existing `getStatus()` method kept for display purposes

2. **src/utils/rpc-proxy-provider.ts** (line ~20)
   - Changed constructor to use `getConfigs()` instead of `getStatus()`
   - Added comment explaining why

## Verification

- Database stores full URLs correctly (TEXT column, unlimited length)
- Admin UI form saves full URLs correctly
- RPC manager now uses full untruncated URLs for actual provider initialization
- Test confirms successful RPC calls with database-provided URLs

## Key Learnings

- Separate concerns: Display/monitoring methods (like `getStatus()`) should not be used for critical functionality
- The truncation in `getStatus()` serves a valid purpose (preventing UI clutter), but needed a non-truncated alternative for internal use
- PostgreSQL TEXT columns have no length limit, so database was never the issue
