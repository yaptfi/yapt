#!/bin/bash

# DeFi Tracker Setup Script

set -e

echo "🚀 Setting up DeFi Passive Income Tracker..."

# Check for required commands
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is not installed. Please install Node.js >= 20.0.0"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is not installed. Please install Docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ Docker Compose is not installed. Please install Docker Compose"; exit 1; }

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version must be >= 20.0.0 (current: $(node -v))"
    exit 1
fi

echo "✅ All prerequisites met"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Start Docker services
echo "🐳 Starting PostgreSQL and Redis..."
docker compose up -d

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
until docker compose exec -T postgres pg_isready -U defi_user -d defi_tracker > /dev/null 2>&1; do
  sleep 1
done

echo "✅ PostgreSQL is ready"

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env and add your ETH_RPC_URL and SESSION_SECRET"
    echo "   Then run: npm run migrate && npm run dev"
else
    echo "✅ .env file already exists"

    # Run migrations
    echo "🗄️  Running database migrations..."
    npm run migrate

    echo ""
    echo "✅ Setup complete! You can now start the server with:"
    echo "   npm run dev"
    echo ""
    echo "📚 API will be available at http://localhost:3000"
    echo "   Health check: http://localhost:3000/health"
fi
