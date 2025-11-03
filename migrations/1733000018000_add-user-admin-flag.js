exports.up = (pgm) => {
  // Add is_admin column to user table
  pgm.addColumn('user', {
    is_admin: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });

  // Set boffola user as admin
  pgm.sql(`
    UPDATE "user"
    SET is_admin = true
    WHERE username = 'boffola' OR username = 'Boffola'
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('user', 'is_admin');
};
