exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE notification_settings
      ADD COLUMN apy_window TEXT NOT NULL DEFAULT '7d'
      CHECK (apy_window IN ('4h', '7d'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE notification_settings
      DROP COLUMN apy_window;
  `);
};
