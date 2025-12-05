/**
 * Test script to manually update Aave Umbrella positions
 */
import { getAdapter } from '../src/plugins/registry';
import { query } from '../src/utils/db';
import { Position } from '../src/types';

async function testUpdate() {
  console.log('Fetching Aave Umbrella positions...\n');

  const result = await query(`
    SELECT p.*, pr.key as protocol_key
    FROM position p
    JOIN protocol pr ON p.protocol_id = pr.id
    WHERE pr.key LIKE 'aave-umbrella%'
    AND p.is_active = true
    ORDER BY pr.key
  `);

  if (!result || !result.rows) {
    console.error('Query failed or returned no results');
    process.exit(1);
  }

  const positions = result.rows as (Position & { protocol_key: string })[];

  console.log(`Found ${positions.length} positions\n`);

  for (const pos of positions) {
    console.log(`\n=== ${pos.display_name} ===`);
    console.log(`Protocol: ${pos.protocol_key}`);
    console.log(`Wallet: ${pos.metadata.walletAddress}\n`);

    try {
      const adapter = getAdapter(pos.protocol_key as any);
      const value = await adapter.readCurrentValue(pos);

      console.log(`✓ Current Value: $${value.toFixed(2)} USD`);
    } catch (error: any) {
      console.error(`✗ Error:`, error.message);
    }
  }

  console.log('\n✓ Test complete');
  process.exit(0);
}

testUpdate().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
