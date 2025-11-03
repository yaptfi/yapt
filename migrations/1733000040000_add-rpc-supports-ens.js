/**
 * Add supportsENS column to rpc_provider table
 *
 * This column indicates whether an RPC provider supports ENS resolution methods
 * (resolveName, lookupAddress). Providers that don't support ENS lookups (like
 * GetBlock.io) should have this set to false.
 *
 * Providers with full ENS support (like Infura, Alchemy) should set to true.
 */

exports.up = (pgm) => {
  pgm.addColumn('rpc_provider', {
    supports_ens: {
      type: 'boolean',
      notNull: true,
      default: true, // Default to true for backwards compatibility
      comment: 'Can handle ENS resolution (resolveName, lookupAddress)',
    },
  });

  // Update comment on table
  pgm.sql(`
    COMMENT ON COLUMN rpc_provider.supports_ens IS
    'Whether provider supports ENS resolution methods. False for GetBlock.io and other providers without ENS support.';
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('rpc_provider', 'supports_ens');
};
