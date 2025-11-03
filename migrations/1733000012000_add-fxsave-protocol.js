/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add f(x) fxSAVE (USDC) protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('fxsave-savings-usdc', 'f(x) fxSAVE (USDC)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove protocol
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'fxsave-savings-usdc';
  `);
};

