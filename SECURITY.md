
### 🛡️ Security & Confirmation Loop

**Important**: OpenClaw agents have powerful capabilities. To prevent unauthorized actions (like file deletion or execution), ClawProxy implements a strict **Human-in-the-Loop** confirmation mechanism.

1.  When an agent attempts a sensitive action, it emits a `requires_confirmation` event.
2.  ClawProxy intercepts this and pauses the stream.
3.  A **System Notice** is injected into the chat:
    > ⚠️ **[SYSTEM NOTICE]** The agent needs your approval to proceed. Please reply with **APPROVE** to authorize the action.
4.  You *must* type `APPROVE` (case-insensitive) as your next message to authorize the action. Any other message will cancel the pending action or be treated as a new prompt, depending on agent behavior.
5.  There is no "auto-approve" setting for high-risk actions. This is by design.

### 🏗️ Architecture

ClawProxy acts as a translation layer between standard OpenAI clients and the OpenClaw Gateway.

\`\`\`mermaid
graph LR
    Client[SillyTavern / OpenWebUI] -- "OpenAI API (HTTP/SSE)" --> Proxy[ClawProxy]
    Proxy -- "Claw Protocol (WebSocket)" --> Gateway[OpenClaw Gateway]
    Gateway -- "Control" --> Agent[Agent Runtime]
    
    subgraph "Your Machine"
    Proxy
    Gateway
    Agent
    end
\`\`\`

- **No Data Storage**: ClawProxy filters and transforms data in-flight. It does not store your conversation history.
- **Direct Connection**: All traffic stays on your local network/machine (unless you configure a remote Gateway).

### ❓ Why ClawProxy?

OpenClaw's native specialized protocol (WebSocket + Event Frames) offers real-time control and deep introspection that standard REST APIs cannot match. However, the ecosystem of AI frontends (like SillyTavern) is built around the OpenAI standard.

ClawProxy bridges this gap without compromising the unique features of OpenClaw, such as:
- **Streaming Thoughts**: Separating internal reasoning from the final answer (configurable).
- **Tool Mapping**: Converting OpenClaw skills into OpenAI-compatible tool definitions.
- **Safety**: Enforcing human confirmation for dangerous tools.
