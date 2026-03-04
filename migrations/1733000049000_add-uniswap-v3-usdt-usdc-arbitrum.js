exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v3-usdt-usdc-arbitrum', 'Uniswap v3 USDT/USDC (Arbitrum)')
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM protocol WHERE key = 'uniswap-v3-usdt-usdc-arbitrum';`);
};
