/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Uniswap v4 USDC/USDT LP position protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v4-usdc-usdt', 'Uniswap v4 USDC/USDT')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Uniswap v4 USDC/USDT protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v4-usdc-usdt';
  `);
};
