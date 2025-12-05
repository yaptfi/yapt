/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Aave Umbrella protocol variants (USDC, USDT, WETH)
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES
      ('aave-umbrella-usdc', 'Aave Umbrella Staked USDC'),
      ('aave-umbrella-usdt', 'Aave Umbrella Staked USDT'),
      ('aave-umbrella-weth', 'Aave Umbrella Staked WETH')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Aave Umbrella protocol entries
  pgm.sql(`
    DELETE FROM protocol WHERE key IN (
      'aave-umbrella-usdc',
      'aave-umbrella-usdt',
      'aave-umbrella-weth'
    );
  `);
};
