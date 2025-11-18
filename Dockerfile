# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built code from builder
COPY --from=builder /app/dist ./dist

# Copy configuration files
COPY config ./config
COPY migrations ./migrations
# Frontend is served separately from `frontend/` during development
COPY .node-pg-migrate.config.js ./
# Copy frontend assets to serve in-container
COPY frontend ./frontend
# Copy .well-known directory for Apple App Site Association
COPY .well-known ./.well-known
## Entrypoint to run both API and frontend server
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY healthcheck.sh ./healthcheck.sh
RUN chmod +x ./docker-entrypoint.sh ./healthcheck.sh

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose ports (API + Frontend UI)
EXPOSE 3000 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application and frontend server
ENV SERVE_FRONTEND=true
ENV FRONTEND_PORT=8080
CMD ["sh", "-lc", "./docker-entrypoint.sh"]
