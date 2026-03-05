/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Uniswap v3 WETH/USDC (Arbitrum) rewards-only protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v3-weth-usdc-arbitrum-rewards', 'Uniswap v3 WETH/USDC (Arbitrum)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Uniswap v3 WETH/USDC (Arbitrum) protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v3-weth-usdc-arbitrum-rewards';
  `);
};
