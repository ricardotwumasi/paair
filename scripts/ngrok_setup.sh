#!/bin/bash
# PAAIR ngrok tunnel setup
# Starts ngrok pointing to n8n on port 5678

set -e

echo "=== PAAIR ngrok Setup ==="

# Check ngrok is installed
if ! command -v ngrok &> /dev/null; then
  echo "ngrok is not installed."
  echo "Install with: brew install ngrok/ngrok/ngrok"
  echo "Then authenticate: ngrok config add-authtoken <your-token>"
  echo "Get a free token at: https://dashboard.ngrok.com/signup"
  exit 1
fi

echo "Starting ngrok tunnel to port 5678 (n8n)..."
echo ""
echo "Once ngrok starts, you will see a Forwarding URL like:"
echo "  https://abc123.ngrok-free.app -> http://localhost:5678"
echo ""
echo "Copy that HTTPS URL and configure Resend:"
echo "  1. Go to https://resend.com/webhooks"
echo "  2. Add webhook for domain paair.ricardotwumasi.com"
echo "  3. Event: email.received"
echo "  4. URL: https://<your-ngrok-url>/webhook/paair-inbound"
echo ""
echo "TIP: For a stable URL, claim a free static domain at"
echo "  https://dashboard.ngrok.com/domains"
echo "  then run: ngrok http 5678 --url=your-domain.ngrok-free.app"
echo ""
echo "Starting ngrok..."
echo ""

ngrok http 5678
