/**
 * Test script to demonstrate concurrent RPC processing performance
 *
 * This simulates multiple users triggering wallet discovery simultaneously
 * and measures the performance improvement from concurrent processing.
 */

import { getProvider, getRPCStatus } from '../src/utils/ethereum';

async function simulateWalletDiscovery(walletId: number, callCount: number): Promise<number> {
  const provider = getProvider();
  const startTime = Date.now();

  console.log(`[Wallet ${walletId}] Starting discovery with ${callCount} RPC calls...`);

  // Simulate the RPC calls that happen during wallet discovery
  // (balance checks, contract calls, event queries, etc.)
  const calls = Array(callCount).fill(null).map(() => provider.getBlockNumber());

  await Promise.all(calls);

  const elapsed = Date.now() - startTime;
  console.log(`[Wallet ${walletId}] ✓ Completed in ${elapsed}ms`);

  return elapsed;
}

async function testSequentialDiscovery() {
  console.log('\n=== Test 1: Sequential Discovery (Baseline) ===\n');

  const walletCount = 3;
  const callsPerWallet = 20;
  const startTime = Date.now();

  // Simulate sequential discovery (one wallet at a time)
  for (let i = 1; i <= walletCount; i++) {
    await simulateWalletDiscovery(i, callsPerWallet);
  }

  const totalTime = Date.now() - startTime;
  console.log(`\nTotal time (sequential): ${totalTime}ms`);
  console.log(`Average per wallet: ${(totalTime / walletCount).toFixed(0)}ms\n`);

  return totalTime;
}

async function testConcurrentDiscovery() {
  console.log('\n=== Test 2: Concurrent Discovery (Multiple Users) ===\n');

  const walletCount = 3;
  const callsPerWallet = 20;
  const startTime = Date.now();

  // Simulate concurrent discovery (all wallets at once - like 3 users clicking "Add Wallet" simultaneously)
  const discoveries = Array(walletCount)
    .fill(null)
    .map((_, i) => simulateWalletDiscovery(i + 1, callsPerWallet));

  await Promise.all(discoveries);

  const totalTime = Date.now() - startTime;
  console.log(`\nTotal time (concurrent): ${totalTime}ms`);
  console.log(`Average per wallet: ${(totalTime / walletCount).toFixed(0)}ms\n`);

  return totalTime;
}

async function showQueueStats() {
  console.log('=== Queue Statistics During Test ===\n');

  const provider = getProvider();

  // Wait for provider to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  const status = getRPCStatus();

  if (!status) {
    console.log('⚠ RPC manager not initialized\n');
    return;
  }

  console.log(`Queue Length: ${status.queue.queueLength}`);
  console.log(`Active Requests: ${status.queue.activeRequests}`);
  console.log(`Max Concurrency: ${status.queue.maxConcurrency}`);
  console.log(`Max Queue Size: ${status.queue.maxQueueSize}\n`);
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   Concurrent RPC Processing Performance Test      ║');
  console.log('╚════════════════════════════════════════════════════╝');

  await showQueueStats();

  const sequentialTime = await testSequentialDiscovery();
  const concurrentTime = await testConcurrentDiscovery();

  const improvement = ((sequentialTime - concurrentTime) / sequentialTime * 100).toFixed(1);
  const speedup = (sequentialTime / concurrentTime).toFixed(2);

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   Performance Summary                              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  console.log(`Sequential Time:  ${sequentialTime}ms`);
  console.log(`Concurrent Time:  ${concurrentTime}ms`);
  console.log(`Improvement:      ${improvement}% faster`);
  console.log(`Speedup:          ${speedup}x\n`);

  if (parseFloat(speedup) > 1.5) {
    console.log('✓ Excellent! Concurrent processing is working effectively.\n');
  } else {
    console.log('⚠ Limited speedup - may be rate limited or low concurrency.\n');
  }
}

main().catch(error => {
  console.error('\n✗ Test failed:', error);
  process.exit(1);
});
