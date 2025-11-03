exports.up = (pgm) => {
  // notification_settings: per-user configuration for alerts
  pgm.createTable('notification_settings', {
    id: 'id',
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
      unique: true, // One settings record per user
    },

    // Stablecoin depeg alerts
    depeg_enabled: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    depeg_severity: {
      type: 'text',
      notNull: true,
      default: 'default',
      check: "depeg_severity IN ('min', 'low', 'default', 'high', 'urgent')",
    },
    depeg_lower_threshold: {
      type: 'numeric(10,4)', // e.g., 0.9900
      notNull: true,
      default: 0.99,
    },
    depeg_upper_threshold: {
      type: 'numeric(10,4)', // e.g., 1.0100
      notNull: false, // NULL means no upper threshold alert
    },

    // APY drop alerts
    apy_enabled: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    apy_severity: {
      type: 'text',
      notNull: true,
      default: 'default',
      check: "apy_severity IN ('min', 'low', 'default', 'high', 'urgent')",
    },
    apy_threshold: {
      type: 'numeric(10,6)', // e.g., 0.010000 for 1%
      notNull: true,
      default: 0.01,
    },

    // ntfy.sh configuration
    ntfy_topic: {
      type: 'text',
      notNull: false, // Will be auto-generated on first enable
      unique: true,
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('notification_settings', 'user_id');

  // notification_log: history of sent notifications
  pgm.createTable('notification_log', {
    id: 'id',
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
    },
    notification_type: {
      type: 'text',
      notNull: true,
      check: "notification_type IN ('depeg', 'apy_drop')",
    },
    severity: {
      type: 'text',
      notNull: true,
      check: "severity IN ('min', 'low', 'default', 'high', 'urgent')",
    },
    title: {
      type: 'text',
      notNull: true,
    },
    message: {
      type: 'text',
      notNull: true,
    },
    metadata: {
      type: 'jsonb',
      notNull: false, // Store details like stablecoin symbol, position info, actual values
    },
    sent_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('notification_log', 'user_id');
  pgm.createIndex('notification_log', 'notification_type');
  pgm.createIndex('notification_log', 'sent_at');
  pgm.createIndex('notification_log', ['user_id', 'notification_type', 'sent_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('notification_log');
  pgm.dropTable('notification_settings');
};
