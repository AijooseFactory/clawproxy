# OpenClaw + OpenWebUI Integration Guide

This guide covers how to connect OpenWebUI to OpenClaw agents, with options for both direct Gateway connection and ClawProxy intermediary.

---

## Quick Start: Direct Gateway Connection

The simplest approach is connecting OpenWebUI directly to the OpenClaw Gateway's HTTP API.

### Prerequisites
- OpenClaw Gateway running (default port `18789`)
- OpenWebUI running (default port `3000`)
- Gateway token from `~/.openclaw/openclaw.json`

### Configuration Steps

1. **Find your Gateway Token**
   ```bash
   cat ~/.openclaw/openclaw.json | grep -A 2 '"auth"'
   # Look for: "token": "YOUR_TOKEN_HERE"
   ```

2. **Configure OpenWebUI**
   - Navigate to **Admin Panel → Settings → Connections**
   - Under **OpenAI API**, configure:
     - **URL**: `http://host.docker.internal:18789/v1`
     - **API Key**: Your gateway token
   - Click **Verify** then **Save**

3. **Enable Models**
   - In the same modal, scroll to **Model IDs**
   - Add your agent names (e.g., `main`, `dev`)
   - Save changes

4. **Test**
   - Start a new chat
   - Select your agent from the model dropdown
   - Send a message

### Gateway HTTP Endpoint Requirements

Ensure your `~/.openclaw/openclaw.json` has HTTP endpoints enabled:

```json
"gateway": {
  "http": {
    "endpoints": {
      "chatCompletions": {
        "enabled": true
      }
    }
  }
}
```

---

## Option 2: Using ClawProxy (Recommended for Advanced Features)

ClawProxy provides additional features like session management, approval workflows, and context optimization.

### Why Use ClawProxy?

| Feature | Direct Gateway | ClawProxy |
|---------|---------------|-----------|
| Session Persistence | ❌ | ✅ |
| Context Stripping | ❌ | ✅ (`stateful` mode) |
| Tool Approval Workflow | ❌ | ✅ |
| API Key Override | ❌ | ✅ |

### ClawProxy Docker Configuration

```yaml
# clawproxy/docker-compose.yml
services:
  clawproxy:
    build: .
    image: openclaw-clawproxy
    container_name: openclaw-clawproxy
    ports:
      - "8080:8080"
    environment:
      - CLAWPROXY_VERBOSE=true
      - CLAWPROXY_PORT=8080
      - CLAWPROXY_HOST=0.0.0.0
      - CLAWPROXY_GATEWAY_URL=ws://openclaw-openclaw-gateway-1:18789
      - CLAWPROXY_GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN
      - CLAWPROXY_API_KEY=sk-your-custom-api-key
      - CLAWPROXY_SESSION_MODE=stateful  # <-- Prevents duplicate context!
      - HOME=/home/node
    volumes:
      - clawproxy-identity:/home/node/.openclaw
    networks:
      - openclaw_default
    restart: always

volumes:
  clawproxy-identity:

networks:
  openclaw_default:
    external: true
```

### OpenWebUI Configuration for ClawProxy

- **URL**: `http://host.docker.internal:8080/v1`
- **API Key**: Value of `CLAWPROXY_API_KEY`

---

## Session History & Cost Optimization

> [!IMPORTANT]
> **Problem**: OpenWebUI sends full conversation history with each request. OpenClaw also maintains its own session history. This causes:
> - Duplicate context sent to the LLM (wasted tokens)
> - Higher costs
> - Potential confusion from overlapping histories

### Solution: Use `stateful` Session Mode

ClawProxy's `stateful` mode strips the context and only sends the **last message** to OpenClaw:

```bash
# Environment variable
CLAWPROXY_SESSION_MODE=stateful

# Or CLI argument
--session-mode stateful
```

**How it works:**
1. OpenWebUI sends: `[system], [user1], [assistant1], [user2], [assistant2], [user3]`
2. ClawProxy extracts only: `[user3]`
3. OpenClaw uses its own session history for context

**Result**: No duplicate history, lower costs, cleaner context.

### Direct Gateway Users

If using the Gateway directly (without ClawProxy), you can configure OpenWebUI to minimize history:

1. Go to **Settings → Interface**
2. Set **Chat History** to a lower number (e.g., 1-2 messages)
3. Or disable **Include Chat History** if available

However, this is less precise than ClawProxy's `stateful` mode.

---

## Troubleshooting

### "500 Server Connection Error" in OpenWebUI
- **Cause**: API URL or token incorrect
- **Fix**: Verify URL and token in Admin Settings → Connections

### Response shows as black dot/loading indicator
- **Cause**: Streaming format incompatibility
- **Fix**: Resolved by anti-buffering headers (`X-Accel-Buffering: no`) and robust stream handling in the latest build. Ensure you are running the latest version.

### ClawProxy shows "connected: false"
- **Cause**: WebSocket authentication issue between ClawProxy and Gateway
- **Fix**: See [ClawProxy WebSocket Troubleshooting](#clawproxy-websocket-issues) below

### Gateway shows "device nonce mismatch"
- **Cause**: ClawProxy device identity changed (container recreated)
- **Fix**: Use a persistent volume for `/home/node/.openclaw`

---

## ClawProxy WebSocket Issues

If ClawProxy cannot connect to the Gateway via WebSocket:

1. **Ensure same Docker network**:
   ```yaml
   networks:
     - openclaw_default
   
   networks:
     openclaw_default:
       external: true
   ```

2. **Use container name for Gateway URL**:
   ```bash
   CLAWPROXY_GATEWAY_URL=ws://openclaw-openclaw-gateway-1:18789
   ```

3. **Persist identity volume**:
   ```yaml
   volumes:
     - clawproxy-identity:/home/node/.openclaw
   ```

4. **Restart both services after changes**:
   ```bash
   cd /path/to/openclaw && docker compose down && docker compose up -d
   cd /path/to/clawproxy && docker compose down && docker compose up -d
   ```

---

## Architecture Overview

```
┌─────────────────┐     HTTP      ┌──────────────┐     WebSocket     ┌──────────────┐
│   OpenWebUI     │ ───────────>  │  ClawProxy   │ ────────────────> │   OpenClaw   │
│  (Port 3000)    │   /v1/chat    │  (Port 8080) │   Gateway API     │   Gateway    │
└─────────────────┘               └──────────────┘                   │  (Port 18789)│
                                        │                            └──────────────┘
                                        │                                    │
                                   Session Mode:                        LLM Providers
                                   - passthrough                        - Ollama Cloud
                                   - stateful                           - Ollama Local
```

**Direct connection** (simpler, no session optimization):
```
┌─────────────────┐     HTTP      ┌──────────────┐
│   OpenWebUI     │ ───────────>  │   OpenClaw   │
│  (Port 3000)    │   /v1/chat    │   Gateway    │
└─────────────────┘               │  (Port 18789)│
                                  └──────────────┘
```
