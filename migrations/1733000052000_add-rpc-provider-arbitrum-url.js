/**
 * Add optional Arbitrum RPC URL per provider entry.
 *
 * Ethereum uses the existing `url` column. Arbitrum support is derived from
 * the presence of `arbitrum_url`.
 */

exports.up = (pgm) => {
  pgm.addColumn('rpc_provider', {
    arbitrum_url: {
      type: 'text',
      notNull: false,
      comment: 'Optional Arbitrum One RPC URL for this provider entry',
    },
  });

  pgm.sql(`
    UPDATE rpc_provider
    SET arbitrum_url = CASE
      WHEN lower(name) = 'infura' AND url LIKE 'https://mainnet.infura.io/v3/%'
        THEN regexp_replace(url, '^https://mainnet\\.infura\\.io/v3/', 'https://arbitrum-mainnet.infura.io/v3/')
      WHEN lower(name) = 'alchemy' AND url LIKE 'https://eth-mainnet.g.alchemy.com/v2/%'
        THEN regexp_replace(url, '^https://eth-mainnet\\.g\\.alchemy\\.com/v2/', 'https://arb-mainnet.g.alchemy.com/v2/')
      WHEN lower(name) = 'getblock'
        THEN 'https://go.getblock.io/355d3f93cf274c968b409d4bc57a597b'
      ELSE NULL
    END
  `);

  pgm.sql(`
    UPDATE rpc_provider
    SET supports_ethereum = true,
        supports_arbitrum = (arbitrum_url IS NOT NULL AND length(trim(arbitrum_url)) > 0)
  `);

  pgm.sql(`
    ALTER TABLE rpc_provider
    ALTER COLUMN supports_ethereum SET DEFAULT true,
    ALTER COLUMN supports_arbitrum SET DEFAULT false
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('rpc_provider', 'arbitrum_url');
};
