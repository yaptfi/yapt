import { ethers } from 'ethers';
import { getEnvVar } from '../src/utils/config';

const RPC_URL = getEnvVar('ETH_RPC_URL');
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FXSP_TOKEN = '0x65C9A641afCEB9C0E6034e558A319488FA0FA3be';

const ERC4626_ABI = [
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function check() {
  console.log('Checking if fxSP is an ERC4626 vault...\n');

  try {
    const vault = new ethers.Contract(FXSP_TOKEN, ERC4626_ABI, provider);

    const underlyingAddr = await vault.asset();
    console.log('✓ fxSP IS an ERC4626 vault!');
    console.log('Underlying asset address:', underlyingAddr);

    const underlying = new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
    const underlyingSymbol = await underlying.symbol();
    const underlyingDecimals = await underlying.decimals();
    console.log('Underlying symbol:', underlyingSymbol);
    console.log('Underlying decimals:', underlyingDecimals.toString());

    // Test conversion of 1,001,668.56 fxSP to underlying
    const fxspAmount = ethers.parseUnits('1001668.556515793169961554', 18);
    const underlyingAmount = await vault.convertToAssets(fxspAmount);
    console.log('\n1,001,668.56 fxSP converts to:', ethers.formatUnits(underlyingAmount, underlyingDecimals), underlyingSymbol);

  } catch (error: any) {
    console.log('✗ fxSP is NOT an ERC4626 vault (or call failed)');
    console.log('Error:', error.message);
  }
}

check().catch(console.error);
