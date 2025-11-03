/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Sky Savings USDS protocol
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('sky-savings-usds', 'Sky Savings USDS')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Sky Savings USDS protocol
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'sky-savings-usds';
  `);
};

