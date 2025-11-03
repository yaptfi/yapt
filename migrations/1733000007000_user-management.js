/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create user table
  pgm.createTable('user', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    username: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    display_name: {
      type: 'text',
      notNull: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('user', 'username');

  // Create authenticator table (for passkeys/WebAuthn)
  pgm.createTable('authenticator', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
    },
    credential_id: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    credential_public_key: {
      type: 'bytea',
      notNull: true,
    },
    counter: {
      type: 'bigint',
      notNull: true,
      default: 0,
    },
    credential_device_type: {
      type: 'text',
      notNull: true,
    },
    credential_backed_up: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    transports: {
      type: 'text',
      notNull: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('authenticator', 'user_id');
  pgm.createIndex('authenticator', 'credential_id');

  // Create user_wallet join table (many-to-many)
  pgm.createTable('user_wallet', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'user',
      onDelete: 'CASCADE',
    },
    wallet_id: {
      type: 'uuid',
      notNull: true,
      references: 'wallet',
      onDelete: 'CASCADE',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('user_wallet', 'user_id');
  pgm.createIndex('user_wallet', 'wallet_id');
  pgm.addConstraint('user_wallet', 'user_wallet_user_id_wallet_id_unique', {
    unique: ['user_id', 'wallet_id'],
  });

  // Drop unique constraint on wallet.address to allow sharing
  pgm.dropConstraint('wallet', 'wallet_address_unique');

  // Create a default "system" user for migration
  pgm.sql(`
    INSERT INTO "user" (username, display_name)
    VALUES ('system', 'System User')
    RETURNING id;
  `);

  // Link all existing wallets to the default user
  pgm.sql(`
    INSERT INTO user_wallet (user_id, wallet_id)
    SELECT
      (SELECT id FROM "user" WHERE username = 'system'),
      id
    FROM wallet;
  `);
};

exports.down = (pgm) => {
  // Remove all user_wallet links
  pgm.dropTable('user_wallet');

  // Drop authenticator table
  pgm.dropTable('authenticator');

  // Drop user table
  pgm.dropTable('user');

  // Restore unique constraint on wallet.address
  pgm.addConstraint('wallet', 'wallet_address_unique', {
    unique: 'address',
  });
};
