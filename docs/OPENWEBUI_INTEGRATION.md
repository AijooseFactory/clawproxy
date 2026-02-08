# OpenClaw + OpenWebUI Integration Guide (Dumb Pipe Architecture)

This guide covers how to connect OpenWebUI to OpenClaw. ensuring that ClawProxy acts as a "Dumb Pipe"—facilitating connection without interfering with the Agent's brain.

---

## Operational Philosophy: The "Dumb Pipe"

**ClawProxy is a pass-through layer.** It does not attempt to "think" or "filter" content for safety or persona.
- **Brain (OpenClaw):** Owns all logic, persona, safety, and tool execution.
- **Pipe (ClawProxy):** Manages the WebSocket connection and formats messages for OpenWebUI.

**User Responsibility:**
You must ensure your OpenClaw agent (`system-prompt.ts`) is correctly configured to handle all safety and persona requirements. Do not rely on ClawProxy to sanitize output.

---

## Session Modes (Critical)

ClawProxy offers two modes for handling chat history. Choose the one that fits your cost/performance needs.

### 1. `passthrough` (Default - Full History)
- **Behavior:** OpenWebUI manages the history. Every request sends the full conversation context to ClawProxy, which forwards it to OpenClaw.
- **Pros:** Stateless; simple to debug.
- **Cons:** **Double Context / High Cost.** OpenClaw *also* has its own memory. Sending the full history again wastes tokens and can confuse the agent with duplicate messages.

### 2. `stateful` (Recommended - Optimized)
- **Behavior:** ClawProxy strips the history sent by OpenWebUI and sends **only the latest user message** to OpenClaw.
- **Mechanism:** OpenClaw relies entirely on its internal session memory (`sessionKey`) to recall the context.
- **Pros:** **Zero Redundancy.** Minimal token usage. Cleaner context for the agent.
- **Cons:** Requires sticky sessions (OpenWebUI must reuse the same `chat_id`).

**Configuration:**
```bash
# In docker-compose.yml
CLAWPROXY_SESSION_MODE=stateful
```

---

## Integration Setup

### Docker Configuration
```yaml
services:
  clawproxy:
    image: openclaw-clawproxy
    environment:
      - CLAWPROXY_GATEWAY_URL=ws://openclaw-openclaw-gateway-1:18789
      - CLAWPROXY_GATEWAY_TOKEN=${GATEWAY_TOKEN}
      - CLAWPROXY_SESSION_MODE=stateful  # <--- SET THIS
      - CLAWPROXY_API_KEY=sk-any-key-you-want
    ports:
      - "8080:8080"
```

### OpenWebUI Settings
- **URL**: `http://host.docker.internal:8080/v1`
- **API Key**: match `CLAWPROXY_API_KEY`
- **Model ID**: `main` (or your agent id)

---

## Troubleshooting

### "Response is a black dot"
- Ensure `X-Accel-Buffering: no` is handled if you use Nginx.
- Check that OpenClaw is actually running and connected to the Gateway.

### "Agent forgot previous context"
- If using `stateful` mode, ensure you haven't restarted the OpenClaw container (which wipes memory unless persisted).
- If using `passthrough`, check if the context window is full.

### "Duplicate messages / Hallucinations"
- You likely have `passthrough` mode enabled while OpenClaw is also tracking history. Switch to `stateful`.
