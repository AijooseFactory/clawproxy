#!/usr/bin/env bash

set -e  # Exit on any error

REPO_URL="https://github.com/aijoosefactory/clawproxy.git"  # Replace with the actual repo URL once created
INSTALL_DIR="$(pwd)/clawproxy"
CONFIG_FILE="$INSTALL_DIR/config.json"

echo "🛠️  ClawProxy Installer"
echo "This script will set up ClawProxy locally via Node.js."

# Check prerequisites
command -v git >/dev/null 2>&1 || { echo "❌ Git is required but not installed. Install it first."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required but not installed. Install Node.js >=18."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm is required but not installed."; exit 1; }

# Clone repo if not already in it
if [ ! -d ".git" ] && [ ! -f "package.json" ]; then
  echo "📥 Cloning ClawProxy repository..."
  git clone "$REPO_URL" clawproxy
  cd clawproxy
  INSTALL_DIR="$(pwd)"
  CONFIG_FILE="$INSTALL_DIR/config.json"
else
  echo "📂 Already in a ClawProxy directory — using current folder."
  if [ -f "package.json" ]; then
    INSTALL_DIR="$(pwd)"
    CONFIG_FILE="$INSTALL_DIR/config.json"
  fi
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create sample config if not exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "⚙️  Creating config.json..."
  cat > "$CONFIG_FILE" << EOL
{
  "httpPort": 8080,
  "httpHost": "127.0.0.1",
  "apiKey": null,
  "gatewayUrl": "ws://127.0.0.1:19001",
  "gatewayToken": "",
  "defaultModel": "dev",
  "verbose": false
}
EOL
fi

# Interactive config prompts
echo "🔑 Configuring ClawProxy..."
read -p "Enter your OpenClaw Gateway Token (required): " gateway_token
if [ -z "$gateway_token" ]; then
  echo "❌ Gateway token is required."
  exit 1
fi

# Cross-platform sed for macOS ('' backup) and Linux
sed -i.bak "s/\"gatewayToken\": \".*\"/\"gatewayToken\": \"$gateway_token\"/" "$CONFIG_FILE" 2>/dev/null || sed -i "s/\"gatewayToken\": \".*\"/\"gatewayToken\": \"$gateway_token\"/" "$CONFIG_FILE"

read -p "Optional: Set an API Key for ClawProxy security (leave blank for none): " api_key
if [ ! -z "$api_key" ]; then
  sed -i.bak "s/\"apiKey\": null/\"apiKey\": \"$api_key\"/" "$CONFIG_FILE" 2>/dev/null || sed -i "s/\"apiKey\": null/\"apiKey\": \"$api_key\"/" "$CONFIG_FILE"
fi

read -p "Enable verbose logging? (y/n, default n): " verbose_input
if [[ "$verbose_input" =~ ^[Yy]$ ]]; then
  sed -i.bak 's/"verbose": false/"verbose": true/' "$CONFIG_FILE" 2>/dev/null || sed -i 's/"verbose": false/"verbose": true/' "$CONFIG_FILE"
fi

# Clean up backup files from macOS sed
rm -f "${CONFIG_FILE}.bak" 2>/dev/null || true

echo "✅ config.json updated at $CONFIG_FILE"

# Offer to start
read -p "🚀 Start ClawProxy now? (y/n): " start_now
if [[ "$start_now" =~ ^[Yy]$ ]]; then
  echo "Starting ClawProxy..."
  npm start
else
  echo "🎉 Setup complete! Run 'npm start' in $INSTALL_DIR to launch ClawProxy."
  echo "Point your client to http://127.0.0.1:8080/v1"
fi
