/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Yearn yvcrvUSD-2 Vault protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('yearn-yvcrvusd-2', 'Yearn yvcrvUSD-2 Vault')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Yearn protocol
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'yearn-yvcrvusd-2';
  `);
};
