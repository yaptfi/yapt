#!/usr/bin/env node

// Quick script to manually trigger wallet updates
const { Queue } = require('bullmq');

const queue = new Queue('position-updates', {
  connection: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
});

async function triggerUpdate() {
  console.log('Triggering immediate wallet update...');
  await queue.add('update-all-wallets', {});
  console.log('Update job added to queue');
  await queue.close();
  process.exit(0);
}

triggerUpdate().catch((err) => {
  console.error('Error triggering update:', err);
  process.exit(1);
});
