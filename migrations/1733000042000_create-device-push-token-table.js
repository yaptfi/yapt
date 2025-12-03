exports.up = (pgm) => {
  // device_push_token: stores device registration for native push notifications (APNs, FCM)
  pgm.createTable('device_push_token', {
    id: 'id',
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
    },

    // Device identification
    device_type: {
      type: 'text',
      notNull: true,
      check: "device_type IN ('ios', 'android', 'web')",
    },
    device_name: {
      type: 'text',
      notNull: false, // e.g., "iPhone 15 Pro", "iPad Mini"
    },
    device_id: {
      type: 'text',
      notNull: false, // Platform-specific identifier (optional)
    },

    // Push token
    push_token: {
      type: 'text',
      notNull: true, // APNs device token or FCM registration token
    },
    endpoint: {
      type: 'text',
      notNull: false, // Web Push endpoint (for future web notifications)
    },

    // Configuration
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    environment: {
      type: 'text',
      notNull: false, // APNs environment: 'production' or 'sandbox'
      check: "environment IS NULL OR environment IN ('production', 'sandbox')",
    },

    // Metadata
    last_used_at: {
      type: 'timestamptz',
      notNull: false,
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

  // Indexes for efficient queries
  pgm.createIndex('device_push_token', 'user_id');
  pgm.createIndex('device_push_token', ['user_id', 'is_active']);
  pgm.createIndex('device_push_token', 'push_token');

  // Prevent duplicate tokens for the same user
  pgm.addConstraint('device_push_token', 'unique_user_push_token', {
    unique: ['user_id', 'push_token'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('device_push_token');
};
