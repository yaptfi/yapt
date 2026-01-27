/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Pendle PT reUSDe protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('pendle-pt-reusde-jun25', 'Pendle PT reUSDe (Jun 2025)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);

  // Add USDe stablecoin if not exists
  pgm.sql(`
    INSERT INTO stablecoin (symbol, name, coingecko_id, decimals)
    VALUES ('USDe', 'Ethena USDe', 'ethena-usde', 18)
    ON CONFLICT (symbol) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // Remove Pendle PT protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'pendle-pt-reusde-jun25';
  `);

  // Note: We don't remove USDe stablecoin as other protocols may depend on it
};
