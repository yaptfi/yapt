/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Yearn USDS vault
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('yearn-yvusds-1', 'Yearn yvUSDS-1 Vault')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);

  // Add Yearn USDC vault
  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('yearn-yvusdc-1', 'Yearn yvUSDC-1 Vault')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Yearn vaults
  pgm.sql(`
    DELETE FROM protocol WHERE key IN ('yearn-yvusds-1', 'yearn-yvusdc-1');
  `);
};
