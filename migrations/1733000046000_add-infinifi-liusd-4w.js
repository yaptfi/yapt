/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Infinifi Locked iUSD (4w)
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('infinifi-liusd-4w', 'Infinifi Locked iUSD (4w)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Infinifi liUSD-4w protocol entry
  pgm.sql(`
    DELETE FROM protocol WHERE key = 'infinifi-liusd-4w';
  `);
};

