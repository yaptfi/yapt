exports.up = (pgm) => {
  // Remove session_id column (no longer needed - single user app)
  pgm.dropColumn('wallet', 'session_id');

  // Add unique constraint on address to prevent duplicates
  pgm.addConstraint('wallet', 'wallet_address_unique', {
    unique: 'address',
  });
};

exports.down = (pgm) => {
  // Remove unique constraint
  pgm.dropConstraint('wallet', 'wallet_address_unique');

  // Add back session_id column
  pgm.addColumn('wallet', {
    session_id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('gen_random_uuid()'),
    },
  });

  // Add back index on session_id
  pgm.createIndex('wallet', 'session_id');
};
