/**
 * Track InfiniFi unwinding (cooldown) positions.
 *
 * - Registers the `infinifi-unwinding` protocol.
 * - Adds `wallet_log_scan_state`, a generic per-wallet checkpoint for
 *   user-filtered historical log scans. It stores the contiguous block range
 *   already scanned plus the event-derived keys found so far, so discovery
 *   only scans new blocks (and resumes older history within a query budget)
 *   instead of rescanning from contract deployment on every run.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('wallet_log_scan_state', {
    wallet_id: {
      type: 'uuid',
      notNull: true,
      references: 'wallet',
      onDelete: 'CASCADE',
    },
    chain_id: {
      type: 'integer',
      notNull: true,
    },
    scan_key: {
      type: 'text',
      notNull: true,
    },
    scanned_from_block: {
      type: 'bigint',
      notNull: false,
    },
    scanned_to_block: {
      type: 'bigint',
      notNull: false,
    },
    found_keys: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint(
    'wallet_log_scan_state',
    'wallet_log_scan_state_pkey',
    { primaryKey: ['wallet_id', 'chain_id', 'scan_key'] }
  );
  pgm.addConstraint(
    'wallet_log_scan_state',
    'wallet_log_scan_state_found_keys_array',
    { check: "jsonb_typeof(found_keys) = 'array'" }
  );

  pgm.sql(`
    INSERT INTO protocol (key, name)
    VALUES ('infinifi-unwinding', 'Infinifi iUSD Unwinding')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM protocol WHERE key = 'infinifi-unwinding';`);
  pgm.dropTable('wallet_log_scan_state');
};
