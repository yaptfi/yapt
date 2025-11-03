/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add Convex Curve Vault protocols and Curve Lending
  pgm.sql(`
    INSERT INTO protocol (key, name) VALUES
      ('convex-cvcrvusd-sdola', 'Convex Staked cvcrvUSD (sDOLA)'),
      ('convex-cvcrvusd-sfrxusd', 'Convex Staked cvcrvUSD (sfrxUSD)'),
      ('convex-cvcrvusd-susde', 'Convex Staked cvcrvUSD (sUSDe)'),
      ('convex-cvcrvusd-fxsave', 'Convex Staked cvcrvUSD (fxSAVE)'),
      ('convex-cvcrvusd-wbtc', 'Convex Staked cvcrvUSD (WBTC)'),
      ('convex-cvcrvusd-sreusd', 'Convex Staked cvcrvUSD (sreUSD)'),
      ('convex-cvcrvusd-wsteth', 'Convex Staked cvcrvUSD (wstETH)'),
      ('convex-cvcrvusd-weth', 'Convex Staked cvcrvUSD (WETH)'),
      ('curve-lending-wbtc', 'Curve Lending Vault (wBTC)')
    ON CONFLICT (key)
    DO UPDATE SET name = EXCLUDED.name;
  `);
};

exports.down = (pgm) => {
  // Remove Convex Curve Vault and Curve Lending protocol entries
  pgm.sql(`
    DELETE FROM protocol WHERE key IN (
      'convex-cvcrvusd-sdola',
      'convex-cvcrvusd-sfrxusd',
      'convex-cvcrvusd-susde',
      'convex-cvcrvusd-fxsave',
      'convex-cvcrvusd-wbtc',
      'convex-cvcrvusd-sreusd',
      'convex-cvcrvusd-wsteth',
      'convex-cvcrvusd-weth',
      'curve-lending-wbtc'
    );
  `);
};
