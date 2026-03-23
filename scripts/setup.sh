#!/bin/bash
# PAAIR Setup Script
# Run this once to install dependencies and configure the environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "================================================"
echo "  PAAIR Setup"
echo "  Personal Assistant AI for Ricardo"
echo "================================================"
echo ""

# ─── Check Prerequisites ───
echo "[1/6] Checking prerequisites..."

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "  ERROR: $1 is not installed. $2"
        exit 1
    else
        echo "  OK: $1 found"
    fi
}

check_command "docker" "Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
check_command "node" "Install Node.js 20+ from https://nodejs.org/"
check_command "npm" "npm should come with Node.js"

# Check Node.js version
NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "  ERROR: Node.js 20+ required (found v${NODE_VERSION})"
    exit 1
fi
echo "  OK: Node.js v${NODE_VERSION}"

# ─── Install Ollama ───
echo ""
echo "[2/6] Checking Ollama..."

if command -v ollama &> /dev/null; then
    echo "  OK: Ollama is installed"
else
    echo "  Installing Ollama..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  Please install Ollama from https://ollama.ai/download"
        echo "  After installing, run this script again."
        exit 1
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -fsSL https://ollama.ai/install.sh | sh
    fi
fi

# ─── Download Model ───
echo ""
echo "[3/6] Downloading Qwen3.5 9B model..."
echo "  This may take several minutes on first run."

# Check if model is already downloaded
if ollama list 2>/dev/null | grep -q "qwen3.5"; then
    echo "  OK: Qwen3.5 model already downloaded"
else
    echo "  Pulling qwen3.5:latest (Q5_K_M quantisation)..."
    ollama pull qwen3.5:latest
fi

# Verify model works
echo "  Testing model inference..."
RESPONSE=$(ollama run qwen3.5:latest "Reply with only the word READY" 2>/dev/null | head -1)
if echo "$RESPONSE" | grep -qi "ready"; then
    echo "  OK: Model responding correctly"
else
    echo "  WARNING: Model response unexpected: $RESPONSE"
    echo "  The model is downloaded but may need troubleshooting."
fi

# ─── Install Node Dependencies ───
echo ""
echo "[4/6] Installing Node.js dependencies..."
cd "$PROJECT_DIR"
npm install

# ─── Environment File ───
echo ""
echo "[5/6] Checking environment configuration..."

if [ -f "$PROJECT_DIR/.env" ]; then
    echo "  OK: .env file exists"
else
    echo "  Creating .env from template..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo "  IMPORTANT: Edit .env with your API keys before starting PAAIR."
    echo "  Required keys: RESEND_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
fi

# ─── Start Docker Services ───
echo ""
echo "[6/6] Starting Docker services..."

cd "$PROJECT_DIR"
docker compose up -d

echo ""
echo "================================================"
echo "  Setup Complete"
echo "================================================"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your API keys (if not done already)"
echo "  2. Set up Telegram bot via @BotFather"
echo "  3. Configure Cloudflare Tunnel or ngrok"
echo "  4. Register Resend webhook pointing to your tunnel URL"
echo "  5. Set up Azure AD app for Microsoft Graph calendar access"
echo "  6. Import n8n workflow from ./workflows/"
echo ""
echo "n8n is available at: http://localhost:5678"
echo "Ollama API is at:    http://localhost:11434"
echo ""
echo "To start PAAIR processing: npx tsx src/index.ts"
echo ""
