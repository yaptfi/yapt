import { ethers } from 'ethers';
import { getEnvVar } from '../src/utils/config';

const RPC_URL = getEnvVar('ETH_RPC_URL');
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FXSP_TOKEN = '0x65C9A641afCEB9C0E6034e558A319488FA0FA3be';

// Try NAV and price-related methods
const METHODS_TO_TRY = [
  { name: 'nav', abi: 'function nav() view returns (uint256)' },
  { name: 'getNav', abi: 'function getNav() view returns (uint256)' },
  { name: 'navPerShare', abi: 'function navPerShare() view returns (uint256)' },
  { name: 'pricePerShare', abi: 'function pricePerShare() view returns (uint256)' },
  { name: 'getPricePerShare', abi: 'function getPricePerShare() view returns (uint256)' },
  { name: 'assetInfo', abi: 'function assetInfo() view returns (uint256 totalManaged, uint256 totalAssets, uint256 totalSupply)' },
  { name: 'totalManaged', abi: 'function totalManaged() view returns (uint256)' },
  { name: 'totalAssets', abi: 'function totalAssets() view returns (uint256)' },
  { name: 'collateralRatio', abi: 'function collateralRatio() view returns (uint256)' },
];

async function check() {
  console.log('Checking fxSP for NAV/price methods...\n');

  const results: any[] = [];

  for (const method of METHODS_TO_TRY) {
    try {
      const contract = new ethers.Contract(FXSP_TOKEN, [method.abi], provider);
      const result = await (contract as any)[method.name]();
      console.log(`✓ ${method.name}():`, result.toString());
      results.push({ method: method.name, value: result });
    } catch (error: any) {
      console.log(`✗ ${method.name}(): ${error.message.slice(0, 80)}`);
    }
  }

  if (results.length > 0) {
    console.log('\n=== Found methods ===');
    for (const r of results) {
      console.log(`${r.method}: ${r.value.toString()}`);
    }
  }
}

check().catch(console.error);
