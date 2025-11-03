import { Queue } from 'bullmq';
import { getEnvVar } from '../src/utils/config';

const QUEUE_NAME = 'position-updates';

async function triggerUpdate() {
  const redisUrl = getEnvVar('REDIS_URL', 'redis://localhost:6379');

  const queue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
    },
  });

  console.log('Triggering update for all wallets...');

  try {
    await queue.add('update-all-wallets', {});
    console.log('Update job added to queue successfully');
  } catch (error) {
    console.error('Failed to trigger update:', error);
    process.exit(1);
  } finally {
    await queue.close();
  }
}

triggerUpdate();
