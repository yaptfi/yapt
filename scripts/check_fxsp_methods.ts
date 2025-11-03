import { ethers } from 'ethers';
import { getEnvVar } from '../src/utils/config';

const RPC_URL = getEnvVar('ETH_RPC_URL');
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FXSP_TOKEN = '0x65C9A641afCEB9C0E6034e558A319488FA0FA3be';

// Try various common methods
const METHODS = [
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function pricePerShare() view returns (uint256)',
  'function getPricePerFullShare() view returns (uint256)',
  'function asset() view returns (address)',
  'function baseToken() view returns (address)',
  'function underlying() view returns (address)',
];

async function check() {
  console.log('Probing fxSP for available methods...\n');

  for (const method of METHODS) {
    const funcName = method.match(/function (\w+)/)?.[1];
    if (!funcName) continue;

    try {
      const contract = new ethers.Contract(FXSP_TOKEN, [method], provider);
      const result = await (contract as any)[funcName]();
      console.log(`✓ ${funcName}():`, result.toString());
    } catch (error: any) {
      console.log(`✗ ${funcName}(): not available`);
    }
  }

  // Also check if it's a simple ERC20
  const erc20 = new ethers.Contract(
    FXSP_TOKEN,
    ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
    provider
  );
  const symbol = await erc20.symbol();
  const decimals = await erc20.decimals();
  console.log(`\nfxSP is ERC20: ${symbol} with ${decimals} decimals`);
}

check().catch(console.error);
