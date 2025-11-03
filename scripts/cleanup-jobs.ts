#!/usr/bin/env tsx
/**
 * Cleanup script to remove all repeatable jobs from BullMQ
 * Run with: npx tsx scripts/cleanup-jobs.ts
 */
import { Queue } from 'bullmq';
import { getEnvVar } from '../src/utils/config';

async function cleanupJobs() {
  const redisUrl = getEnvVar('REDIS_URL', 'redis://localhost:6379');
  const QUEUE_NAME = 'position-updates';

  const queue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
    },
  });

  try {
    console.log('Fetching all repeatable jobs...');
    const repeatableJobs = await queue.getRepeatableJobs();
    console.log(`Found ${repeatableJobs.length} repeatable jobs`);

    for (const job of repeatableJobs) {
      console.log(`Removing job: ${job.name} (${job.id}) - pattern: ${(job as any).pattern || 'N/A'}`);
      await queue.removeRepeatableByKey(job.key);
    }

    console.log('✓ All repeatable jobs removed');

    // Also clean up waiting and delayed jobs
    const waitingJobs = await queue.getWaiting();
    console.log(`Found ${waitingJobs.length} waiting jobs`);
    for (const job of waitingJobs) {
      await job.remove();
    }

    const delayedJobs = await queue.getDelayed();
    console.log(`Found ${delayedJobs.length} delayed jobs`);
    for (const job of delayedJobs) {
      await job.remove();
    }

    console.log('✓ Queue cleaned up');
    await queue.close();

    console.log('\nNow restart the app to recreate the two scheduled jobs:');
    console.log('  docker compose restart app');
  } catch (error) {
    console.error('Error cleaning up jobs:', error);
    await queue.close();
    process.exit(1);
  }
}

cleanupJobs();
