/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Morpheus Gauntlet USDC Prime (gtUSDC)
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('morpheus-gtusdc-prime', 'Morpheus Gauntlet USDC Prime (gtUSDC)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Morpheus protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'morpheus-gtusdc-prime';
  `);
};

