/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Enable UUID extension
  pgm.createExtension('uuid-ossp', { ifNotExists: true });

  // Wallet table
  pgm.createTable('wallet', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    session_id: {
      type: 'text',
      notNull: true,
    },
    address: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('wallet', 'session_id');
  pgm.createIndex('wallet', 'address');

  // Protocol table
  pgm.createTable('protocol', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    key: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    name: {
      type: 'text',
      notNull: true,
    },
  });

  // Insert default protocols
  pgm.sql(`
    INSERT INTO protocol (key, name) VALUES
    ('aave-v3', 'Aave v3'),
    ('curve-scrvusd', 'Curve Savings crvUSD'),
    ('convex-cvxcrv', 'Convex Staked cvxCRV');
  `);

  // Position table
  pgm.createTable('position', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    wallet_id: {
      type: 'uuid',
      notNull: true,
      references: 'wallet',
      onDelete: 'CASCADE',
    },
    protocol_id: {
      type: 'uuid',
      notNull: true,
      references: 'protocol',
      onDelete: 'RESTRICT',
    },
    protocol_position_key: {
      type: 'text',
      notNull: true,
    },
    display_name: {
      type: 'text',
      notNull: true,
    },
    base_asset: {
      type: 'text',
      notNull: true,
    },
    counting_mode: {
      type: 'text',
      notNull: true,
      default: 'count',
      check: "counting_mode IN ('count', 'partial', 'ignore')",
    },
    measure_method: {
      type: 'text',
      notNull: true,
    },
    metadata: {
      type: 'jsonb',
      notNull: true,
      default: '{}',
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
  });

  pgm.createIndex('position', 'wallet_id');
  pgm.createIndex('position', 'protocol_id');
  pgm.createIndex('position', ['wallet_id', 'protocol_position_key'], { unique: true });

  // Position snapshot table
  pgm.createTable('position_snapshot', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    position_id: {
      type: 'uuid',
      notNull: true,
      references: 'position',
      onDelete: 'CASCADE',
    },
    ts: {
      type: 'timestamptz',
      notNull: true,
    },
    value_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    net_flows_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    yield_delta_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    apy_6h: {
      type: 'numeric(20,10)',
      notNull: false,
    },
  });

  pgm.createIndex('position_snapshot', 'position_id');
  pgm.createIndex('position_snapshot', 'ts');
  pgm.createIndex('position_snapshot', ['position_id', 'ts'], { unique: true });

  // Portfolio hourly table
  pgm.createTable('portfolio_hourly', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    session_id: {
      type: 'text',
      notNull: true,
    },
    ts: {
      type: 'timestamptz',
      notNull: true,
    },
    total_value_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    est_daily_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    est_monthly_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
    est_yearly_usd: {
      type: 'numeric(38,18)',
      notNull: true,
    },
  });

  pgm.createIndex('portfolio_hourly', 'session_id');
  pgm.createIndex('portfolio_hourly', 'ts');
  pgm.createIndex('portfolio_hourly', ['session_id', 'ts'], { unique: true });
};

exports.down = (pgm) => {
  pgm.dropTable('portfolio_hourly');
  pgm.dropTable('position_snapshot');
  pgm.dropTable('position');
  pgm.dropTable('protocol');
  pgm.dropTable('wallet');
  pgm.dropExtension('uuid-ossp');
};
