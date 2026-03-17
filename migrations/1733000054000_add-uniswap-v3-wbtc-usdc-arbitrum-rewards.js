/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v3-wbtc-usdc-arbitrum-rewards', 'Uniswap v3 WBTC/USDC (Arbitrum)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v3-wbtc-usdc-arbitrum-rewards';
  `);
};
