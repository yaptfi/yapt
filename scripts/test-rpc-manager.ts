/**
 * Test script for RPC Manager functionality
 *
 * Usage:
 *   npx tsx scripts/test-rpc-manager.ts
 */

import { getProvider, getRPCStatus } from '../src/utils/ethereum';

async function testBasicFunctionality() {
  console.log('=== Test 1: Basic RPC Calls ===');

  const provider = getProvider();

  try {
    const blockNumber = await provider.getBlockNumber();
    console.log(`✓ Current block number: ${blockNumber}`);

    const network = await provider.getNetwork();
    console.log(`✓ Network: ${network.name} (chainId: ${network.chainId})`);

    console.log('\n✓ Basic functionality working\n');
  } catch (error) {
    console.error('✗ Basic functionality failed:', error);
    process.exit(1);
  }
}

async function testRateLimit() {
  console.log('=== Test 2: Rate Limiting ===');

  const provider = getProvider();
  const callCount = 30;
  const startTime = Date.now();

  try {
    // Make rapid calls to test rate limiting
    const promises = Array(callCount)
      .fill(null)
      .map(() => provider.getBlockNumber());

    await Promise.all(promises);

    const elapsed = Date.now() - startTime;
    const avgTime = elapsed / callCount;

    console.log(`✓ Completed ${callCount} calls in ${elapsed}ms`);
    console.log(`✓ Average: ${avgTime.toFixed(2)}ms per call`);

    // With rate limiting, should see delays
    if (avgTime > 50) {
      console.log('✓ Rate limiting appears to be active');
    } else {
      console.log('⚠ Calls very fast - may have multiple providers or high limits');
    }

    console.log();
  } catch (error) {
    console.error('✗ Rate limit test failed:', error);
    process.exit(1);
  }
}

async function testProviderStatus() {
  console.log('=== Test 3: Provider Status ===');

  const status = getRPCStatus();

  if (!status) {
    console.log('⚠ RPC manager not initialized (using fallback single provider)');
    console.log('  This is normal if you have not configured multiple providers\n');
    return;
  }

  console.log('Provider Status:');
  status.providers.forEach((p, index) => {
    console.log(`\n  Provider ${index + 1}: ${p.name}`);
    console.log(`    URL: ${p.url}`);
    console.log(`    Priority: ${p.priority}`);
    console.log(`    Rate Limit: ${p.callsPerSecond} calls/sec`);
    console.log(`    Daily Quota: ${p.callsPerDay ?? 'unlimited'}`);
    console.log(`    Daily Calls: ${p.dailyCallCount}`);
    console.log(`    Available Tokens: ${p.availableTokens.toFixed(2)}`);
    console.log(`    Health: ${p.isHealthy ? '✓ Healthy' : '✗ Degraded'}`);
    console.log(`    Consecutive Errors: ${p.consecutiveErrors}`);

    if (p.nextTokenIn > 0) {
      console.log(`    Next Token In: ${p.nextTokenIn.toFixed(0)}ms`);
    }
  });

  console.log('\nQueue Status:');
  console.log(`  Queue Length: ${status.queue.queueLength}`);
  console.log(`  Max Queue Size: ${status.queue.maxQueueSize}`);
  console.log(`  Active Requests: ${status.queue.activeRequests}`);
  console.log(`  Max Concurrency: ${status.queue.maxConcurrency}`);

  console.log('\n✓ Provider status retrieved successfully\n');
}

async function testConcurrentCalls() {
  console.log('=== Test 4: Concurrent Calls ===');

  const provider = getProvider();
  const concurrency = 10;

  try {
    const startTime = Date.now();

    // Make multiple different types of calls concurrently
    const promises = [
      provider.getBlockNumber(),
      provider.getGasPrice(),
      provider.getBlockNumber(),
      provider.getNetwork(),
      provider.getBlockNumber(),
      provider.getGasPrice(),
      provider.getBlockNumber(),
      provider.getGasPrice(),
      provider.getBlockNumber(),
      provider.getNetwork(),
    ];

    const results = await Promise.all(promises);
    const elapsed = Date.now() - startTime;

    console.log(`✓ Completed ${concurrency} concurrent calls in ${elapsed}ms`);
    console.log(`✓ Results: block=${results[0]}, gasPrice=${results[1]}`);
    console.log();
  } catch (error) {
    console.error('✗ Concurrent calls test failed:', error);
    process.exit(1);
  }
}

async function testErrorHandling() {
  console.log('=== Test 5: Error Handling ===');

  const provider = getProvider();

  try {
    // Try to get a non-existent block (should handle gracefully)
    await provider.getBlock(999999999999);
    console.log('⚠ Expected error but call succeeded (block may exist)');
  } catch (error) {
    if (error instanceof Error) {
      console.log(`✓ Error handled correctly: ${error.message.substring(0, 80)}...`);
    }
  }

  console.log();
}

async function showConfiguration() {
  console.log('=== Current Configuration ===\n');

  const singleUrl = process.env.ETH_RPC_URL;
  const multiUrls = process.env.ETH_RPC_URLS;
  const limits = process.env.ETH_RPC_LIMITS;

  console.log('Environment Variables:');
  console.log(`  ETH_RPC_URL: ${singleUrl ? singleUrl.substring(0, 50) + '...' : 'not set'}`);
  console.log(`  ETH_RPC_URLS: ${multiUrls || 'not set'}`);
  console.log(`  ETH_RPC_LIMITS: ${limits || 'not set'}`);

  console.log('\nConfiguration Mode:');
  if (multiUrls) {
    console.log('  ✓ Multiple providers (environment)');
  } else if (singleUrl) {
    console.log('  ✓ Single provider (fallback)');
  } else {
    console.log('  ✗ No RPC URL configured');
  }

  console.log();
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   RPC Manager Test Suite              ║');
  console.log('╚════════════════════════════════════════╝\n');

  await showConfiguration();

  await testBasicFunctionality();
  await testRateLimit();
  await testProviderStatus();
  await testConcurrentCalls();
  await testErrorHandling();

  console.log('╔════════════════════════════════════════╗');
  console.log('║   All Tests Completed Successfully!   ║');
  console.log('╚════════════════════════════════════════╝\n');
}

main().catch(error => {
  console.error('\n✗ Test suite failed:', error);
  process.exit(1);
});
