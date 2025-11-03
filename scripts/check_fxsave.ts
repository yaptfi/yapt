import { ethers } from 'ethers';
import { getEnvVar } from '../src/utils/config';

const RPC_URL = getEnvVar('ETH_RPC_URL');
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FXSAVE_VAULT = '0x7743e50f534a7f9f1791dde7dcd89f7783eefc39';
const WALLET = '0xcbE72c8Dc34af0Dc8e7a70Df4C1Da0ef23FeCA8E';

const ERC4626_ABI = [
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function check() {
  const vault = new ethers.Contract(FXSAVE_VAULT, ERC4626_ABI, provider);

  const underlyingAddr = await vault.asset();
  console.log('Underlying asset address:', underlyingAddr);

  const underlying = new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
  const underlyingSymbol = await underlying.symbol();
  const underlyingDecimals = await underlying.decimals();
  console.log('Underlying symbol:', underlyingSymbol);
  console.log('Underlying decimals:', underlyingDecimals.toString());

  const shareDecimals = await vault.decimals();
  console.log('Share decimals:', shareDecimals.toString());

  const shares = await vault.balanceOf(WALLET);
  const assets = await vault.convertToAssets(shares);

  console.log('\nShare balance:', ethers.formatUnits(shares, shareDecimals));
  console.log('Asset value:', ethers.formatUnits(assets, underlyingDecimals));

  console.log('\nAsset value (USD):', parseFloat(ethers.formatUnits(assets, underlyingDecimals)));
}

check().catch(console.error);
