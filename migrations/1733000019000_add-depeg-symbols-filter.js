exports.up = (pgm) => {
  pgm.addColumn('notification_settings', {
    depeg_symbols: {
      type: 'text[]',
      notNull: false, // NULL => all supported stablecoins
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('notification_settings', 'depeg_symbols');
};

