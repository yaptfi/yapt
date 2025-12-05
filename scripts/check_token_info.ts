/**
 * Check token info (symbol, decimals) for reward tokens
 */
import { getContract } from '../src/utils/ethereum';
import { getAbi } from '../src/utils/config';

const tokens = [
  '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', // USDT reward token
  '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', // USDC reward token
];

async function checkTokens() {
  const erc20Abi = getAbi('ERC20');

  for (const tokenAddr of tokens) {
    console.log(`\nToken: ${tokenAddr}`);
    try {
      const contract = getContract(tokenAddr, erc20Abi);
      const [symbol, decimals, name] = await Promise.all([
        contract.symbol(),
        contract.decimals(),
        contract.name(),
      ]);

      console.log(`  Name: ${name}`);
      console.log(`  Symbol: ${symbol}`);
      console.log(`  Decimals: ${decimals}`);
    } catch (error: any) {
      console.error(`  Error:`, error.message);
    }
  }
}

checkTokens()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
