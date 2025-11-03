#!/usr/bin/env tsx
/**
 * List all repeatable jobs in the queue
 * Run with: npx tsx scripts/list-jobs.ts
 */
import { Queue } from 'bullmq';
import { getEnvVar } from '../src/utils/config';

async function listJobs() {
  const redisUrl = getEnvVar('REDIS_URL', 'redis://localhost:6379');
  const QUEUE_NAME = 'position-updates';

  const queue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
    },
  });

  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    console.log(`\nFound ${repeatableJobs.length} scheduled repeatable jobs:\n`);

    for (const job of repeatableJobs) {
      const pattern = (job as any).pattern || 'N/A';
      const tz = (job as any).tz || 'local';
      console.log(`  • ${job.name}`);
      console.log(`    ID: ${job.id}`);
      console.log(`    Cron: ${pattern}`);
      console.log(`    Timezone: ${tz}`);
      console.log(`    Next run: ${new Date(job.next).toISOString()}\n`);
    }

    await queue.close();
  } catch (error) {
    console.error('Error listing jobs:', error);
    await queue.close();
    process.exit(1);
  }
}

listJobs();
