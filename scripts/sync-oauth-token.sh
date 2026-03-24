#!/bin/bash
# Sync Claude Code OAuth token from macOS keychain to .env
# Run via launchd every hour to keep bot authenticated.
#
# Usage: bash scripts/sync-oauth-token.sh

ENV_FILE="$(dirname "$0")/../.env"
KEYCHAIN_SERVICE="Claude Code-credentials"

# Read token from keychain
CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)
if [ -z "$CREDS" ]; then
  echo "ERROR: Cannot read Claude Code credentials from keychain"
  exit 1
fi

# Extract accessToken
NEW_TOKEN=$(echo "$CREDS" | python3 -c "
import json, sys, time
d = json.loads(sys.stdin.read())
oauth = d.get('claudeAiOauth', {})
token = oauth.get('accessToken', '')
expires = oauth.get('expiresAt', 0)
now = int(time.time() * 1000)
remaining = (expires - now) / 60000
if remaining < 0:
    print('EXPIRED')
else:
    print(token)
" 2>/dev/null)

if [ -z "$NEW_TOKEN" ] || [ "$NEW_TOKEN" = "EXPIRED" ]; then
  echo "WARNING: Token expired or empty, cannot update"
  exit 1
fi

# Read current token from .env
CURRENT_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2)

if [ "$NEW_TOKEN" = "$CURRENT_TOKEN" ]; then
  echo "Token unchanged, no update needed"
  exit 0
fi

# Update .env
sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$NEW_TOKEN|" "$ENV_FILE"
echo "Token updated in .env"

# Restart NanoClaw to pick up new token
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null
echo "NanoClaw restarted with new token"
