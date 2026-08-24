/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES
      ('uniswap-v4-eth-usdc-ethereum-rewards', 'Uniswap v4 ETH/USDC (Ethereum)'),
      ('uniswap-v4-eth-usdc-arbitrum-rewards', 'Uniswap v4 ETH/USDC (Arbitrum)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM protocol
    WHERE key IN (
      'uniswap-v4-eth-usdc-ethereum-rewards',
      'uniswap-v4-eth-usdc-arbitrum-rewards'
    );
  `);
};
