/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create stablecoin table
  pgm.createTable('stablecoin', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    symbol: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    name: {
      type: 'text',
      notNull: true,
    },
    coingecko_id: {
      type: 'text',
      notNull: false,
    },
    decimals: {
      type: 'integer',
      notNull: true,
      default: 18,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('stablecoin', 'symbol');

  // Seed initial stablecoins with CoinGecko IDs
  pgm.sql(`
    INSERT INTO stablecoin (symbol, name, coingecko_id, decimals) VALUES
    ('USDC', 'USD Coin', 'usd-coin', 6),
    ('USDT', 'Tether', 'tether', 6),
    ('DAI', 'Dai Stablecoin', 'dai', 18),
    ('crvUSD', 'Curve USD', 'crvusd', 18),
    ('iUSD', 'Infinifi USD', 'infinifi-usd', 18);
  `);

  // Add stablecoin_id foreign key to position table (nullable initially)
  pgm.addColumns('position', {
    stablecoin_id: {
      type: 'uuid',
      notNull: false,
      references: 'stablecoin',
      onDelete: 'RESTRICT',
    },
  });

  // Backfill stablecoin_id from existing base_asset values
  pgm.sql(`
    UPDATE position
    SET stablecoin_id = s.id
    FROM stablecoin s
    WHERE position.base_asset = s.symbol;
  `);

  // Make stablecoin_id NOT NULL after backfill
  pgm.alterColumn('position', 'stablecoin_id', {
    notNull: true,
  });

  // Create index for foreign key
  pgm.createIndex('position', 'stablecoin_id');

  // Note: Keeping base_asset column for backwards compatibility
  // It can be dropped in a future migration after confirming everything works
};

exports.down = (pgm) => {
  // Drop foreign key and column
  pgm.dropIndex('position', 'stablecoin_id');
  pgm.dropColumns('position', ['stablecoin_id']);

  // Drop stablecoin table
  pgm.dropTable('stablecoin');
};
