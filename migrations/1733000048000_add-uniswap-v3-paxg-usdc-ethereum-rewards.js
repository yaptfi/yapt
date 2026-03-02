exports.up = (pgm) => {
  // Add Uniswap v3 PAXG/USDC (Ethereum) rewards-only protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('uniswap-v3-paxg-usdc-ethereum-rewards', 'Uniswap v3 PAXG/USDC (Ethereum)')
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // Remove Uniswap v3 PAXG/USDC (Ethereum) protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'uniswap-v3-paxg-usdc-ethereum-rewards';
  `);
};
