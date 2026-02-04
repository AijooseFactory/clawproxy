# ClawProxy ⭐

![ClawProxy Banner](src/assets/clawproxy-banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

ClawProxy is a lightweight OpenAI-compatible API proxy for [OpenClaw](https://github.com/openclaw/openclaw). It enables you to use any OpenAI-compatible client (such as OpenWebUI, SillyTavern, LM Studio, or the OpenAI SDK) to interact with your local OpenClaw agents.

## Features

- **Standard OpenAI API**: Exposes `/v1/models` and `/v1/chat/completions`.
- **Streaming Support**: Full Server-Sent Events (SSE) support for real-time token streaming.
- **Secure**: Optional API Key authentication and local binding.
- **Flexible Configuration**: Configure via JSON file, environment variables, or CLI flags.
- **Gateway Integration**: Connects directly to the OpenClaw Gateway via WebSocket (Protocol v3) with auto-reconnect.
- **Docker Ready**: Includes a production-optimized Dockerfile.
- **Health Monitoring**: Built-in `/health` endpoint.
- **Persistent Logic**: Requires a long-running process (Docker/Node.js) to handle OpenClaw sessions and confirmations. **Not compatible with Serverless** (Lambda/Vercel) as-is.

## Installation

### One-Command Installation (Easiest for Node.js users)

Run this single command to automatically clone, install, configure, and optionally start ClawProxy:

```bash
curl -fsSL https://raw.githubusercontent.com/aijoosefactory/clawproxy/main/install.sh | bash
```

> **Security note**: Always review installer scripts before piping to bash. This one is safe — it only installs Node dependencies and sets up config.

### Method 1: Run with npx (Quickest)
You can run ClawProxy directly without installing it globally if you have the repository locally.

```bash
# From within the clawproxy directory
npm install
npm start
```

### Method 2: Build from Source
If you have the source code locally (e.g., in a standalone directory or monorepo):

```bash
cd clawproxy
npm install
npm run build
# The binary is now at dist/index.js
node dist/index.js
```

### Method 3: Docker
```bash
docker build -t clawproxy .
docker run -p 8080:8080 -e CLAWPROXY_GATEWAY_TOKEN="your-token" clawproxy
# Notes: 
# - The container exposes port 8080 and listens on 0.0.0.0 by default.
# - It includes a built-in healthcheck.
```

### Method 4: Docker Compose
Create a `docker-compose.yml` file:

```yaml
version: '3.8'
services:
  clawproxy:
    image: clawproxy:latest # Or build: .
    ports:
      - "8080:8080"
    environment:
      - CLAWPROXY_GATEWAY_TOKEN=your-token-here
      - CLAWPROXY_API_KEY=optional-secret
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
```

> **Cloud Deployment**: For platforms like Railway, Fly.io, or Render, simply deploy this repository or push the Docker image to a registry. Set the `CLAWPROXY_GATEWAY_TOKEN` environment variable in your cloud provider's dashboard.

## Security & Confirmations

See [SECURITY.md](./SECURITY.md) for details on how ClawProxy handles OpenClaw's permission requests and architecture.

## Configuration

ClawProxy prioritizes configuration in this order:
1. **CLI Arguments**
2. **Environment Variables**
3. **Config File** (`./config.json` or `~/.clawproxy/config.json`)
4. **Defaults**

### Options Reference

| Option | CLI Flag | Env Variable | JSON Key | Default |
|----------|---------|--------------|----------|---------|
| **HTTP Port** | `--port` | `CLAWPROXY_PORT` | `httpPort` | `8080` |
| **HTTP Host** | `--host` | `CLAWPROXY_HOST` | `httpHost` | `127.0.0.1` |
| **API Key** | `--api-key` | `CLAWPROXY_API_KEY` | `apiKey` | (None) |
| **Gateway URL** | `--gateway-url` | `CLAWPROXY_GATEWAY_URL` | `gatewayUrl` | `ws://127.0.0.1:19001` |
| **Gateway Token**| `--gateway-token`| `CLAWPROXY_GATEWAY_TOKEN`| `gatewayToken`| (None) |
| **Default Model**| `--model` | `CLAWPROXY_DEFAULT_MODEL`| `defaultModel` | `dev` |
| **Verbose Logs** | `--verbose` | `CLAWPROXY_VERBOSE` | `verbose` | `false` |

### 🔐 API Key Authentication (`CLAWPROXY_API_KEY`)

**Why use it?**
If you expose ClawProxy to a network (by setting host to `0.0.0.0` or running in Docker), anyone on that network can use your agents. Setting an API Key adds a requirement for clients to provide a `Bearer` token.

**Why NOT use it?**
If you are running strictly on `127.0.0.1` (localhost) and you trust the users on your computer, you can leave it blank for easier setup.

**How to generate one?**
You can use any string, but a random secret is best:
```bash
openssl rand -hex 32
# Output example: 8f3a9...
```
Set this as `CLAWPROXY_API_KEY=8f3a9...` and configure your client (SillyTavern/OpenWebUI) to use the same key.

> **Warning**: The default `httpHost` is `127.0.0.1` for Node.js usage (for security) but `0.0.0.0` inside Docker. If running effectively remotely, secure your network and use `apiKey` authentication.

### Configuration Example (`config.json`)
```json
{
  "httpPort": 8080,
  "httpHost": "127.0.0.1",
  "apiKey": "sk-my-secret-key",
  "gatewayUrl": "ws://127.0.0.1:19001",
  "gatewayToken": "720ed579...",
  "defaultModel": "dev",
  "verbose": true
}
```

## Token Management (Gateway Connectivity)

ClawProxy requires a valid **Gateway Token** to connect to the OpenClaw Gateway. **This token is generated and managed by the OpenClaw Gateway**, not by ClawProxy.

### How to Find Your Token
1.  **Check your `.env` file**: Look for `OPENCLAW_GATEWAY_TOKEN` in the `.env` file where your OpenClaw Gateway is installed.
2.  **Check Gateway Logs**: When you start the OpenClaw Gateway, the token is printed to the console.



## Usage

### 1. Start OpenClaw
Ensure your OpenClaw Gateway is running. Note the Gateway Token from your `.env` or startup logs.

### 2. Start ClawProxy
> **Where is my token?** You can find your gateway token in your OpenClaw `.env` file under the key `OPENCLAW_GATEWAY_TOKEN`, or in the output logs when you start the OpenClaw Gateway.

```bash
export CLAWPROXY_GATEWAY_TOKEN="your-token-here"
npm start
```

### 3. Connect a Client
Point your client (e.g., OpenWebUI, SillyTavern, LM Studio) to:
- **Base URL**: `http://127.0.0.1:8080/v1`
- **API Key**: (Your configured key, or anything if auth is disabled)

### Verification Commands

**List Models:**
```bash
curl http://127.0.0.1:8080/v1/models
```

**Chat Completion:**
```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dev",
    "messages": [{"role": "user", "content": "Hello world"}]
  }'
```

**Health Check:**
```bash
curl http://127.0.0.1:8080/health
```

## Troubleshooting

- **Finding Gateway Token**: Look in your OpenClaw `.env` file or Gateway startup logs.
- **Connection Refused**: Check if OpenClaw Gateway is running on the correct port (default 19001).
- **401 Unauthorized**: If you set `apiKey`, you must send `Authorization: Bearer <key>`.
- **"WebSocket error"**: Verify your `gatewayToken` matches the one in OpenClaw's `.env`.

## Compatibility

ClawProxy is tested with:
- **OpenWebUI**
- **SillyTavern**
- **LM Studio**
- **curl** / **OpenAI Node SDK**

*Note: Tool calling passthrough is not currently supported; the proxy handles text interaction while the agent executes tools internally.*


## Contributing

ClawProxy uses strict TypeScript and modern best practices:
- **Strict Typing**: All code must pass `tsc` with `strict: true` (implied).
- **Validation**: API requests are validated using `zod`.
- **Events**: Internal event handling uses `EventEmitter` rather than callbacks.

Please ensure `npm run build` passes before submitting PRs.

## License

MIT
