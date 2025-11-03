#!/bin/sh
# Health check script for Docker container
# Checks HTTP or HTTPS depending on HTTPS_ENABLED env var

if [ "$HTTPS_ENABLED" = "true" ]; then
  wget --no-check-certificate -q -O- https://localhost:${PORT:-3443}/health > /dev/null 2>&1
else
  wget -q -O- http://localhost:${PORT:-3000}/health > /dev/null 2>&1
fi
