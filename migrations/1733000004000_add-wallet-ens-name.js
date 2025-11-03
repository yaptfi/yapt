/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add optional ENS name to wallets
  pgm.addColumn('wallet', {
    ens_name: { type: 'text', notNull: false },
  });

  // Index for lookup (not unique, ENS names can change/overlap historically)
  pgm.createIndex('wallet', 'ens_name');
};

exports.down = (pgm) => {
  pgm.dropIndex('wallet', 'ens_name');
  pgm.dropColumn('wallet', 'ens_name');
};

