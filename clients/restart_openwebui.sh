#!/bin/bash
echo "Restarting OpenWebUI with Dottie (OpenClaw) configuration..."
cd "$(dirname "$0")"
docker compose -f docker-compose.openwebui.yml down
docker compose -f docker-compose.openwebui.yml up -d --force-recreate
echo "Done! OpenWebUI should be running at http://localhost:3000"
