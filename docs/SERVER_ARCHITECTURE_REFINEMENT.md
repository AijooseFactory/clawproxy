Server Architecture Refinement

This walkthrough documents the successful resolution of the persistent "hanging request" and "connection closed" issues in ClawProxy, achieving a stable and performant chat integration with OpenWebUI.

🎯 Goal
The objective was to fix the instability where chat responses would either hang indefinitely or disconnect immediately after the first token.

🐛 Root Cause Analysis
The investigation revealed a multi-faceted failure:

Missing CORS: The server lacked Cross-Origin Resource Sharing configuration, causing browsers to reject the connection immediately.
Fragile Socket Handling: The initial implementation manually wrote to the raw HTTP socket (reply.raw.write), bypassing Fastify's connection lifecycle management.
Premature Close Detection: The server hooked into request.raw.on('close') to clean up resources. However, this event was firing prematurely or was being misinterpreted, causing the server to kill the stream before completion.
Buffering: Intermediaries (like Docker or Nginx) were buffering the stream, causing it to appear "hung" until the buffer filled or timeout occurred.
🛠️ Solution Implemented
1. Robust Streaming with PassThrough
We replaced the manual socket logic with Node.js PassThrough streams. This delegates connection management to the framework.

typescript
// Old (Fragile)
reply.raw.write('data: ...');
// New (Robust)
const stream = new PassThrough();
reply.send(stream);
stream.write('data: ...');
2. Correct Lifecycle Management
We moved the resource cleanup logic to the Stream's close event, rather than the Request's close event. This ensures we only disconnect the upstream client when the response is truly finished or the client actually disconnects.

typescript
// New Lifecycle Handler
stream.on('close', () => {
    client.off('event', eventHandler);
});
3. Connection & Buffering Headers
We explicitly configured headers to preventing buffering and ensure persistence.

typescript
reply.header('Connection', 'keep-alive');
reply.header('X-Accel-Buffering', 'no'); // Critical for instant tokens
4. CORS Integration
We installed and configured @fastify/cors (v9).

typescript
await server.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
});
✅ Verification
The implementation was verified using curl to simulate a client request without browser interference, confirming:

Status 200 OK
Stream Headers: text/event-stream, chunked
Instant Data: Tokens arrive immediately (no buffering).
Persistence: Connection stays open until [DONE].
User confirmed: "You did it!"

📜 Key Files Modified
src/server.ts
: Complete streaming refactor.
package.json
: Added @fastify/cors.