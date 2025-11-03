# Flow Detection Removal

## Issue

Wallet discovery was failing with Alchemy's free tier due to excessive RPC calls:

```
Error: Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.
Based on your parameters, this block range should work: [0x0, 0x9].
```

The system was scanning historical blocks to detect deposits/withdrawals (net flows) via `Transfer` events. For DeFi positions that could be months or years old, this required scanning millions of blocks at 10 blocks per request = hundreds of thousands of RPC calls.

## Root Cause Analysis

The flow detection logic was designed for **infrequent updates** (daily/weekly), where distinguishing deposits from yield was critical:

- Position grows 1000 → 1100 USDC in 7 days
- Could be: 90 USDC deposit + 10 USDC yield (1.5% APY)
- Or: 0 deposit + 100 USDC yield (52% APY)

But with **hourly updates**, this problem disappears:

- 20% APY = ~0.0023% per hour
- Any jump >2% in one hour is obviously a deposit/withdrawal, not yield
- Flow detection becomes unnecessary overhead

## Solution

Removed all flow detection code:

1. **Update Service** (`src/services/update.ts`)
   - Removed all `calcNetFlows()` calls
   - Set `netFlowsUsd` to 0 in all snapshots
   - Simplified APY calculation to just compare current value to reference value
   - Removed block scanning cursor management

2. **Base Adapter** (`src/sdk/adapter.ts`)
   - Made `calcNetFlows()` optional (marked with `?` in interface)
   - Added default implementation that returns `{netFlowsUsd: 0, fromBlock, toBlock}`
   - Method kept for backwards compatibility but no longer required

3. **All Protocol Adapters** (12 files)
   - Removed entire `calcNetFlows()` method implementations
   - Removed unused imports: `NetFlowResult`, `detectNetFlowsFromTransfers`, `estimateSharePriceUsd`
   - Adapters now inherit the default no-op implementation from base class

## Benefits

### Performance
- **Discovery**: No historical event scanning → instant position discovery
- **Updates**: Only read current balance → minimal RPC calls per position
- **RPC Compatibility**: Works with any provider including Alchemy free tier

### Simplicity
- **Codebase**: ~1000 lines of complex event scanning code removed
- **Maintenance**: No need to handle edge cases in flow detection
- **Testing**: Simpler test cases without flow scenarios

### Accuracy
With hourly updates, the simplified approach is **equally accurate**:
- Yield deltas are tiny (~0.002% per hour at 20% APY)
- Deposits/withdrawals are obvious from magnitude (>2% change)
- APY calculations remain precise using two-point method

## Trade-offs

### What We Lost
- Cannot distinguish between:
  - Large yield spike (unlikely but possible)
  - Deposit at same time as update (creates reset snapshot)

But this is acceptable because:
- With hourly sampling, yield spikes are smoothed out
- 2% threshold triggers reset snapshot, which is correct behavior

### What We Kept
- **Reset snapshots**: Still detect >2% value changes and create reset snapshots
- **Exit detection**: Still archive positions when balance reaches $0
- **Reward positions**: Still track absolute earnings for volatile-principal positions
- **APY accuracy**: Still accurate with 4h/7d/30d windows

## Implementation Details

### Before (with flow detection)
```typescript
// Scan last hour of blocks for Transfer events
const fromBlock = lastScannedBlock || currentBlock - 300;
const netFlows = await adapter.calcNetFlows(position, fromBlock, 'latest');

// Correct for deposits/withdrawals
const base = previousValue + netFlows;
const yieldDelta = currentValue - base;
```

### After (simplified)
```typescript
// Just compare current to previous
const yieldDelta = currentValue - previousValue;

// Large changes trigger reset (deposit/withdrawal)
if (Math.abs(yieldDelta / previousValue) > 0.02) {
  await createResetSnapshot(position.id, currentValue, changeType);
}
```

## Files Modified

### Core Logic (2 files)
- `src/services/update.ts` - Removed flow detection from update loop
- `src/sdk/adapter.ts` - Made calcNetFlows optional with default implementation

### Protocol Adapters (12 files)
All adapters had their `calcNetFlows()` methods removed:
1. `src/adapters/aave-v3.ts`
2. `src/adapters/curve-scrvusd.ts`
3. `src/adapters/sky-savings-usds.ts`
4. `src/adapters/yearn-v3.ts`
5. `src/adapters/morpheus-gtusdc-prime.ts`
6. `src/adapters/infinifi-siusd.ts`
7. `src/adapters/fxsave-savings-usdc.ts`
8. `src/adapters/curve-lending-wbtc.ts`
9. `src/adapters/convex-curve-vault.ts`
10. `src/adapters/convex-cvcrvusd-wbtc.ts`
11. `src/adapters/convex-cvxcrv.ts`
12. `src/adapters/uniswap-v4.ts`

## Database Impact

The `position_snapshot` table still has the `net_flows_usd` column, but it's always set to 0 now. This column is kept for potential future use if needed.

## Testing

To verify the system works without flow detection:

```bash
# Discovery should complete instantly without block scanning errors
docker compose logs app --follow

# Try discovering a wallet via UI - should see no Alchemy block range errors
# Updates should complete quickly with minimal RPC calls
```

## Future Considerations

If we ever need flow detection again (e.g., for daily updates instead of hourly):

1. The `calcNetFlows()` interface still exists (optional)
2. Adapters can implement it individually
3. Update service can be modified to use it selectively
4. Database column (`net_flows_usd`) is already in place

But with hourly updates, this is unlikely to be needed.
