/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add USDS stablecoin
  pgm.sql(`
    INSERT INTO stablecoin (symbol, name, coingecko_id, decimals)
    VALUES ('USDS', 'USDS', 'usds', 18)
    ON CONFLICT (symbol)
    DO UPDATE SET
      name = EXCLUDED.name,
      coingecko_id = EXCLUDED.coingecko_id,
      decimals = EXCLUDED.decimals;
  `);
};

exports.down = (pgm) => {
  // Remove USDS stablecoin
  pgm.sql(`
    DELETE FROM stablecoin WHERE symbol = 'USDS';
  `);
};
