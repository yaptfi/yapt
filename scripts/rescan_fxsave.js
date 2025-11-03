/*
  Rescan a wallet for fxSAVE positions and force an immediate update snapshot.
  Usage (from repo root):
    DATABASE_URL=... ETH_RPC_URL=... node scripts/rescan_fxsave.js 0xYourWallet
*/

const { initPlugins } = require('../dist/plugins/loader');
const { toChecksumAddress } = require('../dist/utils/ethereum');
const { getWalletByAddress, createWallet } = require('../dist/models/wallet');
const { discoverPositionsForProtocol } = require('../dist/services/discovery');
const { getPositionsByWallet } = require('../dist/models/position');
const { updatePosition } = require('../dist/services/update');

async function main() {
  const addrArg = process.argv[2];
  if (!addrArg) {
    console.error('Usage: node scripts/rescan_fxsave.js <walletAddress>');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  if (!process.env.ETH_RPC_URL) {
    console.error('ETH_RPC_URL not set');
    process.exit(1);
  }

  const address = toChecksumAddress(addrArg);

  // Load built-in plugins (register adapters)
  await initPlugins();

  // Ensure wallet exists
  let wallet = await getWalletByAddress(address);
  if (!wallet) {
    wallet = await createWallet(address, null);
    console.log(`Created wallet ${wallet.id} for ${address}`);
  } else {
    console.log(`Found wallet ${wallet.id} for ${address}`);
  }

  // Rediscover fxSAVE for this wallet (upserts metadata)
  await discoverPositionsForProtocol(wallet.id, wallet.address, 'fxsave-savings-usdc');
  console.log('Discovery for fxsave-savings-usdc complete');

  // Fetch positions for this wallet and update only fxSAVE positions
  const positions = await getPositionsByWallet(wallet.id);
  const fxsavePositions = positions.filter(
    (p) => p?.metadata?.protocolKey === 'fxsave-savings-usdc' || p?.protocol_key === 'fxsave-savings-usdc'
  );

  if (fxsavePositions.length === 0) {
    console.log('No fxSAVE positions found for this wallet.');
    return;
  }

  console.log(`Updating ${fxsavePositions.length} fxSAVE position(s)...`);
  for (const pos of fxsavePositions) {
    await updatePosition(pos);
  }

  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

