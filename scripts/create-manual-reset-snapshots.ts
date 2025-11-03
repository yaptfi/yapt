import { query, queryOne } from '../src/utils/db';

/**
 * Create manual reset snapshots for positions that had partial exits
 * before the reset snapshot feature was deployed
 */

async function createManualResetSnapshots() {
  console.log('Creating manual reset snapshots for positions with historical partial exits...\n');

  // Position IDs that had partial exits
  const positions = [
    {
      id: '44e7c47d-dece-42e4-aaeb-7f8e12f3db3c',
      name: 'Convex Staked cvcrvUSD (WBTC)',
      previousValue: 516012.45,
      newValue: 216006.34,
      reason: 'Partial exit from $516K to $216K'
    },
    {
      id: '3c3113b7-5be1-40cf-a0d8-43d7e5e15589',
      name: 'Aave v3 USDC',
      previousValue: 600306.75,
      newValue: 400306.90,
      reason: 'Partial exit from $600K to $400K'
    }
  ];

  for (const position of positions) {
    console.log(`\n${position.name}:`);
    console.log(`  Previous value: $${position.previousValue.toFixed(2)}`);
    console.log(`  New baseline: $${position.newValue.toFixed(2)}`);
    console.log(`  Reason: ${position.reason}`);

    // Get latest snapshot to use its timestamp + 1 second
    const latestSnapshot = await queryOne<{ ts: Date; value_usd: string }>(
      'SELECT ts, value_usd FROM position_snapshot WHERE position_id = $1 ORDER BY ts DESC LIMIT 1',
      [position.id]
    );

    if (!latestSnapshot) {
      console.log(`  ⚠️  No existing snapshots found, skipping`);
      continue;
    }

    const resetTime = new Date(new Date(latestSnapshot.ts).getTime() + 1000); // +1 second
    const currentValue = parseFloat(latestSnapshot.value_usd);

    console.log(`  Latest snapshot: ${latestSnapshot.ts.toISOString()}, value=$${currentValue.toFixed(2)}`);
    console.log(`  Creating reset snapshot at: ${resetTime.toISOString()}`);

    // Insert reset snapshot
    try {
      await query(
        `INSERT INTO position_snapshot (
          position_id, ts, value_usd, net_flows_usd, yield_delta_usd, apy, is_reset
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (position_id, ts) DO UPDATE SET
          is_reset = EXCLUDED.is_reset,
          net_flows_usd = EXCLUDED.net_flows_usd,
          yield_delta_usd = EXCLUDED.yield_delta_usd,
          apy = EXCLUDED.apy`,
        [
          position.id,
          resetTime,
          currentValue.toString(),
          '0',      // net_flows_usd = 0 (reset baseline)
          '0',      // yield_delta_usd = 0 (no yield yet)
          null,     // apy = null (no previous data)
          true      // is_reset = true
        ]
      );
      console.log(`  ✓ Reset snapshot created successfully`);
    } catch (error: any) {
      console.error(`  ✗ Failed to create reset snapshot: ${error.message}`);
    }
  }

  console.log('\n✓ Manual reset snapshot creation completed');
  process.exit(0);
}

createManualResetSnapshots().catch((error) => {
  console.error('Error creating manual reset snapshots:', error);
  process.exit(1);
});
