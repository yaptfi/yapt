/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create archive table for exited positions
  pgm.createTable('position_archive', {
    id: {
      type: 'uuid',
      primaryKey: true,
    },
    wallet_id: {
      type: 'uuid',
      notNull: true,
    },
    protocol_id: {
      type: 'uuid',
      notNull: true,
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
    },
    archived_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    exit_reason: {
      type: 'text',
      notNull: false,
      comment: 'Reason for archiving: complete_exit, user_archived',
    },
  });

  pgm.createIndex('position_archive', 'wallet_id');
  pgm.createIndex('position_archive', 'archived_at');
  pgm.createIndex('position_archive', 'exit_reason');

  // Create archive table for snapshots of exited positions
  pgm.createTable('position_snapshot_archive', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    position_id: {
      type: 'uuid',
      notNull: true,
      comment: 'References archived position (not FK to avoid cascade issues)',
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
    apy: {
      type: 'numeric(20,10)',
      notNull: false,
    },
    archived_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('position_snapshot_archive', 'position_id');
  pgm.createIndex('position_snapshot_archive', 'ts');
  pgm.createIndex('position_snapshot_archive', 'archived_at');
};

exports.down = (pgm) => {
  pgm.dropTable('position_snapshot_archive');
  pgm.dropTable('position_archive');
};
