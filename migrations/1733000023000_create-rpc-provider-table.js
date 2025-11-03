/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create rpc_provider table
  pgm.createTable('rpc_provider', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
    },
    url: {
      type: 'text',
      notNull: true,
    },
    calls_per_second: {
      type: 'numeric(10,2)',
      notNull: true,
      default: 10,
    },
    calls_per_day: {
      type: 'integer',
      notNull: false,
    },
    priority: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create indexes
  pgm.createIndex('rpc_provider', 'is_active');
  pgm.createIndex('rpc_provider', ['priority', 'is_active']);

  // Seed with default provider from ENV (if ETH_RPC_URL is set)
  // This will be handled by the application on first run to avoid
  // requiring ENV vars during migration
  pgm.sql(`
    COMMENT ON TABLE rpc_provider IS 'RPC provider configurations for Ethereum node access';
    COMMENT ON COLUMN rpc_provider.calls_per_second IS 'Maximum RPC calls per second (rate limit)';
    COMMENT ON COLUMN rpc_provider.calls_per_day IS 'Maximum RPC calls per day (optional daily quota)';
    COMMENT ON COLUMN rpc_provider.priority IS 'Provider priority (higher = preferred, used for sorting)';
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('rpc_provider');
};
