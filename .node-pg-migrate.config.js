/**
 * node-pg-migrate configuration
 * Used by: npm run migrate
 *
 * The hardcoded URL is for local development only.
 * Production should always set DATABASE_URL environment variable.
 */
module.exports = {
  // Production: Always set DATABASE_URL in .env.prod
  // Development: Uses Docker Compose credentials as fallback
  databaseUrl: process.env.DATABASE_URL || 'postgresql://defi_user:defi_password@localhost:5432/defi_tracker',
  migrationsTable: 'pgmigrations',
  dir: 'migrations',
  checkOrder: false,
  direction: 'up',
  verbose: true,
};
