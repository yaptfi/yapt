/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v3-weth-usdc-ethereum-rewards', 'Uniswap v3 WETH/USDC (Ethereum)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v3-weth-usdc-ethereum-rewards';
  `);
};
