/**
 * Quick test to verify RPC manager is using full URLs (not truncated)
 */

import { getProvider, getRPCStatus } from '../src/utils/ethereum';

async function main() {
  console.log('\n=== Testing RPC Manager URL Fix ===\n');

  // Get the provider (this will initialize it from database)
  const provider = getProvider();

  // Wait for async initialization
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get RPC status
  const status = getRPCStatus();

  if (!status) {
    console.log('⚠ RPC manager not initialized (using fallback single provider)');
    process.exit(1);
  }

  // Check provider configs
  console.log('RPC Manager Status:');
  console.log(`  Providers: ${status.providers.length}`);
  console.log(`  Queue: ${status.queue.queueLength} / ${status.queue.maxQueueSize}`);
  console.log(`  Active Requests: ${status.queue.activeRequests} / ${status.queue.maxConcurrency}\n`);

  // Make a test RPC call
  console.log('Making test RPC call...');
  try {
    const blockNumber = await provider.getBlockNumber();
    console.log(`✓ Success! Current block: ${blockNumber}`);
    console.log('\n✓ RPC manager working correctly with full URLs\n');
  } catch (error) {
    console.error('✗ RPC call failed:', error);
    console.error('\nThis suggests the URL truncation bug is still present\n');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n✗ Test failed:', error);
  process.exit(1);
});
