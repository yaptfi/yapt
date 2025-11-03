/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Ensure protocol row exists and has the correct name
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('infinifi-siusd', 'Infinifi Staked iUSD')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);

  // Update existing positions under this protocol to use iUSD as base asset
  pgm.sql(`
    UPDATE position
    SET base_asset = 'iUSD'
    WHERE protocol_id = (SELECT id FROM protocol WHERE key = 'infinifi-siusd')
      AND base_asset <> 'iUSD';
  `);
};

exports.down = (pgm) => {
  // Best-effort revert: set protocol name back and base_asset back to 'USD'
  pgm.sql(`
    UPDATE protocol SET name = 'Infinifi Staked USD' WHERE key = 'infinifi-siusd';
  `);

  pgm.sql(`
    UPDATE position
    SET base_asset = 'USD'
    WHERE protocol_id = (SELECT id FROM protocol WHERE key = 'infinifi-siusd')
      AND base_asset = 'iUSD';
  `);
};

