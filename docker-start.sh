#!/bin/bash

# DeFi Tracker - Docker Startup Script
set -e

echo "🚀 DeFi Passive Income Tracker - Docker Setup"
echo "=============================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed!"
    echo ""
    echo "Please install Docker first:"
    echo "  macOS: brew install --cask docker"
    echo "  Linux: curl -fsSL https://get.docker.com | sh"
    echo "  Windows: https://www.docker.com/products/docker-desktop"
    exit 1
fi

echo "✅ Docker is installed"

# Check if docker compose is available
if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available!"
    echo "Please install Docker Compose v2+"
    exit 1
fi

echo "✅ Docker Compose is available"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.docker .env
    echo ""
    echo "⚠️  IMPORTANT: You need to configure .env file!"
    echo ""
    echo "Required settings:"
    echo "  1. ETH_RPC_URL - Get free API key from:"
    echo "     - Alchemy: https://www.alchemy.com/"
    echo "     - Infura: https://infura.io/"
    echo ""
    echo "  2. SESSION_SECRET - Generate a random string:"
    echo "     openssl rand -base64 32"
    echo ""
    echo "Please edit .env and then run this script again."
    echo ""
    exit 0
fi

# Check if ETH_RPC_URL is configured
if grep -q "YOUR_API_KEY_HERE" .env; then
    echo "⚠️  .env file exists but ETH_RPC_URL is not configured!"
    echo ""
    echo "Please edit .env and set your Ethereum RPC URL"
    echo "Get a free API key from Alchemy or Infura"
    echo ""
    exit 1
fi

echo "✅ .env file is configured"
echo ""

# Build and start services
echo "🏗️  Building Docker images..."
docker compose build

echo ""
echo "🚀 Starting all services..."
docker compose up -d

echo ""
echo "⏳ Waiting for services to be healthy..."

# Wait for services to be healthy (max 60 seconds)
SECONDS=0
MAX_WAIT=60

while [ $SECONDS -lt $MAX_WAIT ]; do
    if docker compose ps | grep -q "defi-tracker-app.*Up.*healthy"; then
        echo ""
        echo "✅ All services are running and healthy!"
        break
    fi

    if [ $SECONDS -ge $MAX_WAIT ]; then
        echo ""
        echo "⚠️  Services took longer than expected to start"
        echo "Check logs with: docker compose logs"
        exit 1
    fi

    sleep 2
    echo -n "."
done

echo ""
echo ""
echo "🎉 SUCCESS! DeFi Tracker is now running!"
echo "=============================================="
echo ""
echo "📊 Service Status:"
docker compose ps
echo ""
echo "🌐 API Endpoints:"
echo "  - Health Check: http://localhost:3000/health"
echo "  - Add Wallet:   POST http://localhost:3000/api/wallets"
echo "  - Portfolio:    GET http://localhost:3000/api/portfolio/summary"
echo ""
echo "📚 Next Steps:"
echo "  1. Test the health endpoint:"
echo "     curl http://localhost:3000/health"
echo ""
echo "  2. Add your first wallet:"
echo "     curl -X POST http://localhost:3000/api/wallets \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -c cookies.txt \\"
echo "       -d '{\"address\": \"0x...\"}'"
echo ""
echo "  3. View portfolio:"
echo "     curl http://localhost:3000/api/portfolio/summary -b cookies.txt"
echo ""
echo "📖 Documentation:"
echo "  - Docker Guide: ./DOCKER_DEPLOY.md"
echo "  - API Guide:    ./NEXT_STEPS.md"
echo "  - Full README:  ./README.md"
echo ""
echo "🔧 Useful Commands:"
echo "  - View logs:    docker compose logs -f"
echo "  - Stop:         docker compose stop"
echo "  - Restart:      docker compose restart"
echo "  - Stop & clean: docker compose down"
echo ""
