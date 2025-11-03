import { ethers } from 'ethers';
import { getEnvVar } from '../src/utils/config';

const RPC_URL = getEnvVar('ETH_RPC_URL');
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FXSP_TOKEN = '0x65C9A641afCEB9C0E6034e558A319488FA0FA3be';
const WALLET = '0xcbE72c8Dc34af0Dc8e7a70Df4C1Da0ef23FeCA8E';

async function test() {
  const fxsp = new ethers.Contract(
    FXSP_TOKEN,
    [
      'function nav() view returns (uint256)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ],
    provider
  );

  const nav = await fxsp.nav();
  const totalSupply = await fxsp.totalSupply();
  const decimals = await fxsp.decimals();

  console.log('fxSP nav():', ethers.formatUnits(nav, 18));
  console.log('fxSP totalSupply:', ethers.formatUnits(totalSupply, decimals));
  console.log('fxSP decimals:', decimals.toString());

  // If nav() is per-token value in 18 decimals:
  console.log('\nIf nav() is price per fxSP in 18 decimals:');
  console.log('  1 fxSP =', ethers.formatUnits(nav, 18), 'USDC');

  // Test with actual balance
  console.log('\n--- Testing with actual fxSP amount from fxSAVE ---');
  const fxspAmount = 1001668556515793169961554n; // from earlier test
  const fxspAmountReadable = parseFloat(ethers.formatUnits(fxspAmount, 18));
  const navPerToken = parseFloat(ethers.formatUnits(nav, 18));
  const usdcValue = fxspAmountReadable * navPerToken;

  console.log('fxSP amount:', fxspAmountReadable.toFixed(6));
  console.log('NAV per fxSP:', navPerToken);
  console.log('USDC value:', usdcValue.toFixed(6));
}

test().catch(console.error);
