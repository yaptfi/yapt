/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v4-wbtc-usdc-rewards', 'Uniswap v4 WBTC/USDC')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v4-wbtc-usdc-rewards';
  `);
};
