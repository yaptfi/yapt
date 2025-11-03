/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add REUSD stablecoin
  pgm.sql(`
    INSERT INTO stablecoin (symbol, name, coingecko_id, decimals)
    VALUES ('REUSD', 'ReSupply USD', 'resupply-usd', 18)
    ON CONFLICT (symbol)
    DO UPDATE SET
      name = EXCLUDED.name,
      coingecko_id = EXCLUDED.coingecko_id,
      decimals = EXCLUDED.decimals;
  `);
};

exports.down = (pgm) => {
  // Remove REUSD stablecoin
  pgm.sql(`
    DELETE FROM stablecoin WHERE symbol = 'REUSD';
  `);
};
