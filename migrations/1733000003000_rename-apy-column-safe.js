/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Conditionally rename apy_6h -> apy if needed
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'position_snapshot' AND column_name = 'apy_6h'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'position_snapshot' AND column_name = 'apy'
      ) THEN
        ALTER TABLE position_snapshot RENAME COLUMN apy_6h TO apy;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  // Conditionally rename apy -> apy_6h if needed
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'position_snapshot' AND column_name = 'apy'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'position_snapshot' AND column_name = 'apy_6h'
      ) THEN
        ALTER TABLE position_snapshot RENAME COLUMN apy TO apy_6h;
      END IF;
    END
    $$;
  `);
};

