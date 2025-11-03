import { Queue, Worker } from 'bullmq';
import { getAllWallets, getWalletById } from '../models/wallet';
import { getPositionsByWallet } from '../models/position';
import { updateWallet } from '../services/update';
import { getEnvVar } from '../utils/config';
import { discoverPositions } from '../services/discovery';
import { cleanupUntrackedWallets } from '../services/cleanup';
import { checkAndSendNotifications } from '../services/notificationChecker';

const QUEUE_NAME = 'position-updates';

let updateQueue: Queue | null = null;
let updateWorker: Worker | null = null;

/**
 * Initialize the job queue and worker
 */
export async function initializeScheduler(): Promise<void> {
  const redisUrl = getEnvVar('REDIS_URL', 'redis://localhost:6379');

  // Create queue
  updateQueue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
    },
  });

  // Create worker
  updateWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`Processing job ${job.id}: ${job.name}`);

      if (job.name === 'update-wallet') {
        const { walletId } = job.data;
        const positions = await getPositionsByWallet(walletId);
        await updateWallet(walletId, positions);
      } else if (job.name === 'update-all-wallets') {
        const wallets = await getAllWallets();
        console.log(`Updating ${wallets.length} wallets sequentially (1 wallet/second)...`);

        // Process wallets sequentially with 1-second delay between each
        for (let i = 0; i < wallets.length; i++) {
          const wallet = wallets[i];
          const positions = await getPositionsByWallet(wallet.id);
          await updateWallet(wallet.id, positions);

          // Add 1-second delay between wallets (skip after last wallet)
          if (i < wallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        // After all wallets are updated, check notification conditions
        console.log('All wallets updated, checking notifications...');
        await checkAndSendNotifications();
      } else if (job.name === 'discover-wallet') {
        const { walletId } = job.data as { walletId: string };
        const wallet = await getWalletById(walletId);
        if (!wallet) return;
        await discoverPositions(wallet.id, wallet.address);
      } else if (job.name === 'discover-all-wallets') {
        const wallets = await getAllWallets();
        console.log(`Discovering positions for ${wallets.length} wallets...`);
        for (const wallet of wallets) {
          await updateQueue!.add('discover-wallet', { walletId: wallet.id });
        }
      } else if (job.name === 'cleanup-untracked-wallets') {
        console.log('[scheduler] running weekly cleanup of untracked wallets');
        await cleanupUntrackedWallets();
      }
    },
    {
      connection: {
        url: redisUrl,
      },
      concurrency: 1, // Process wallets sequentially, not concurrently
    }
  );

  updateWorker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  updateWorker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });

  // Schedule hourly updates
  await scheduleHourlyUpdates();
  // Schedule weekly cleanup of untracked wallets (Sunday 02:00 UTC)
  await scheduleWeeklyCleanup();

  console.log('Scheduler initialized');
}

/**
 * Schedule hourly updates for all wallets
 */
async function scheduleHourlyUpdates(): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }

  // Get update minute from env (default: 38 for dev, prod should use 48)
  // Avoids minute 0 which is when most cron jobs run
  // Allows staggering multiple environments to avoid RPC rate limits
  const updateMinute = getEnvVar('UPDATE_CRON_MINUTE', '38');
  const cronPattern = `${updateMinute} * * * *`;

  // Add repeatable job that runs every hour
  await updateQueue.add(
    'update-all-wallets',
    {},
    {
      repeat: {
        pattern: cronPattern,
      },
      jobId: 'update-all-wallets-hourly',
    }
  );

  console.log(`Scheduled hourly wallet updates at minute ${updateMinute} (cron: ${cronPattern})`);
}

/**
 * Schedule weekly cleanup of untracked wallets
 * Runs every Sunday at 02:00 UTC
 */
async function scheduleWeeklyCleanup(): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }

  // Avoid duplicating scheduled jobs
  try {
    const repeats = await updateQueue.getRepeatableJobs();
    const existing = repeats.find((r) => r.name === 'cleanup-untracked-wallets' && r.id === 'cleanup-untracked-wallets-weekly');
    if (existing) {
      console.log(`[scheduler] weekly cleanup already scheduled: ${(existing as any).pattern || (existing as any).cron || 'set'}`);
      return;
    }
  } catch {
    // ignore
  }

  const cronPattern = `0 2 * * 0`;
  await updateQueue.add(
    'cleanup-untracked-wallets',
    {},
    {
      repeat: {
        pattern: cronPattern,
        tz: 'UTC',
      },
      jobId: 'cleanup-untracked-wallets-weekly',
    }
  );

  console.log(`[scheduler] scheduled weekly cleanup at ${cronPattern} (UTC)`);
}

/**
 * Manually trigger an update for a specific wallet
 */
export async function triggerWalletUpdate(walletId: string): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }

  await updateQueue.add('update-wallet', { walletId });
}

/**
 * Manually trigger updates for all wallets
 */
export async function triggerAllWalletsUpdate(): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }

  await updateQueue.add('update-all-wallets', {});
}

/**
 * Manually trigger discovery for a specific wallet
 */
export async function triggerWalletDiscovery(walletId: string): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }

  await updateQueue.add('discover-wallet', { walletId });
}

/**
 * Manually trigger discovery for all wallets
 */
export async function triggerAllWalletsDiscovery(): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }
  await updateQueue.add('discover-all-wallets', {});
}

/**
 * Manually trigger weekly cleanup task
 */
export async function triggerWeeklyCleanup(): Promise<void> {
  if (!updateQueue) {
    throw new Error('Queue not initialized');
  }
  await updateQueue.add('cleanup-untracked-wallets', {});
}

/**
 * Shutdown the scheduler gracefully
 */
export async function shutdownScheduler(): Promise<void> {
  if (updateWorker) {
    await updateWorker.close();
  }
  if (updateQueue) {
    await updateQueue.close();
  }
  console.log('Scheduler shut down');
}
