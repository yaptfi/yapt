/**
 * Direct test of Aave Umbrella adapter readCurrentValue
 */
import { AaveUmbrellaAdapter } from '../src/adapters/aave-umbrella';
import { Position } from '../src/types';

async function test() {
  // Test USDT position
  console.log('=== Testing USDT Position ===\n');

  const usdtAdapter = new AaveUmbrellaAdapter('aave-umbrella-usdt', 'Aave Umbrella Staked USDT');

  const usdtPosition: Position = {
    id: 'test-usdt',
    walletId: 'test-wallet',
    protocolPositionKey: 'test',
    displayName: 'Aave Umbrella Staked USDT',
    baseAsset: 'USDT',
    countingMode: 'count',
    measureMethod: 'exchangeRate',
    metadata: {
      walletAddress: '0x80D0d54050C15971b21e877D95441800f5AA9ee8',
      stakeToken: '0xA484Ab92fe32B143AEE7019fC1502b1dAA522D31',
      wrappedToken: '0x7Bc3485026Ac48b6cf9BaF0A377477Fff5703Af8',
      baseAsset: 'USDT',
      decimals: 6,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    protocolId: 1,
  };

  try {
    const value = await usdtAdapter.readCurrentValue(usdtPosition);
    console.log(`✓ USDT Value: $${value.toFixed(2)}\n`);
  } catch (error: any) {
    console.error(`✗ USDT Error:`, error.message);
  }

  // Test USDC position
  console.log('=== Testing USDC Position ===\n');

  const usdcAdapter = new AaveUmbrellaAdapter('aave-umbrella-usdc', 'Aave Umbrella Staked USDC');

  const usdcPosition: Position = {
    id: 'test-usdc',
    walletId: 'test-wallet',
    protocolPositionKey: 'test',
    displayName: 'Aave Umbrella Staked USDC',
    baseAsset: 'USDC',
    countingMode: 'count',
    measureMethod: 'exchangeRate',
    metadata: {
      walletAddress: '0x80D0d54050C15971b21e877D95441800f5AA9ee8',
      stakeToken: '0x6bf183243FdD1e306ad2C4450BC7dcf6f0bf8Aa6',
      baseAsset: 'USDC',
      decimals: 6,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    protocolId: 1,
  };

  try {
    const value = await usdcAdapter.readCurrentValue(usdcPosition);
    console.log(`✓ USDC Value: $${value.toFixed(2)}\n`);
  } catch (error: any) {
    console.error(`✗ USDC Error:`, error.message);
  }

  console.log('✓ Test complete');
  process.exit(0);
}

test().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
