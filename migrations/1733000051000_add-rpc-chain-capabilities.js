/**
 * Add chain capability columns to rpc_provider table.
 *
 * These columns control which chain-specific RPC managers can use a provider.
 * Ethereum uses the primary `url`; Arbitrum support is enabled only when a
 * provider entry is explicitly configured for it.
 */

exports.up = (pgm) => {
  pgm.addColumn('rpc_provider', {
    supports_ethereum: {
      type: 'boolean',
      notNull: true,
      default: true,
      comment: 'Whether provider can be used for Ethereum mainnet (chainId 1)',
    },
    supports_arbitrum: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'Whether provider can be used for Arbitrum One (chainId 42161)',
    },
  });

  pgm.createIndex('rpc_provider', ['is_active', 'supports_ethereum', 'priority'], {
    name: 'rpc_provider_active_eth_priority_idx',
  });
  pgm.createIndex('rpc_provider', ['is_active', 'supports_arbitrum', 'priority'], {
    name: 'rpc_provider_active_arb_priority_idx',
  });

  pgm.sql(`
    COMMENT ON COLUMN rpc_provider.supports_ethereum IS
    'Whether provider can serve Ethereum mainnet requests (chainId 1).';
  `);

  pgm.sql(`
    COMMENT ON COLUMN rpc_provider.supports_arbitrum IS
    'Whether provider can serve Arbitrum One requests (chainId 42161).';
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex('rpc_provider', ['is_active', 'supports_ethereum', 'priority'], {
    name: 'rpc_provider_active_eth_priority_idx',
  });
  pgm.dropIndex('rpc_provider', ['is_active', 'supports_arbitrum', 'priority'], {
    name: 'rpc_provider_active_arb_priority_idx',
  });
  pgm.dropColumn('rpc_provider', ['supports_ethereum', 'supports_arbitrum']);
};
