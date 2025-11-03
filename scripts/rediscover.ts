import { discoverPositions } from '../src/services/discovery';

const walletId = process.argv[2];
const walletAddress = process.argv[3];

if (!walletId || !walletAddress) {
  console.error('Usage: ts-node scripts/rediscover.ts <walletId> <walletAddress>');
  process.exit(1);
}

discoverPositions(walletId, walletAddress)
  .then((positions) => {
    console.log(`Discovered ${positions.length} positions`);
    positions.forEach((p) => {
      console.log(`  - ${p.displayName} (${p.baseAsset})`);
    });
    process.exit(0);
  })
  .catch((error) => {
    console.error('Discovery failed:', error);
    process.exit(1);
  });
