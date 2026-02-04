import Fastify, { type FastifyInstance } from 'fastify';
import { GatewayClient } from './lib/client';
import { type ClawProxyConfig } from './config';

export type ServerOptions = {
    port: number;
    host: string;
    gatewayUrl: string;
    gatewayToken?: string;
};

export async function createServer(config: ClawProxyConfig): Promise<FastifyInstance> {
    const server = Fastify({
        logger: config.verbose ? { level: 'debug' } : { level: 'info' }
    });

    // Initialize Gateway Client
    const client = new GatewayClient({
        url: config.gatewayUrl,
        token: config.gatewayToken
    });

    // Connect to Gateway on startup
    try {
        await client.start();
        server.log.info('Connected to OpenClaw Gateway');

        // Log available agents
        try {
            const result = await client.request<{ agents: { id: string, name?: string }[] }>('agents.list');
            const agentNames = result.agents.map(a => `${a.name || a.id} (${a.id})`).join(', ');
            server.log.info(`Available Agents: ${agentNames}`);
        } catch (err) {
            server.log.warn('Failed to fetch initial agent list');
        }

    } catch (err) {
        server.log.error(err, 'Failed to connect to Gateway');
        process.exit(1);
    }

    // Auth Middleware
    server.addHook('onRequest', async (request, reply) => {
        if (request.url === '/health') return;
        if (config.apiKey) {
            const authHeader = request.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${config.apiKey}`) {
                return reply.code(401).send({
                    error: {
                        message: 'Invalid API Key',
                        type: 'invalid_request_error',
                        param: null,
                        code: 'invalid_api_key'
                    }
                });
            }
        }
    });

    // Error Handler
    server.setErrorHandler((error, _request, reply) => {
        server.log.error(error);
        reply.code(500).send({
            error: {
                message: error.message || 'Internal Server Error',
                type: 'server_error',
                param: null,
                code: 'internal_error'
            }
        });
    });

    // Routes
    server.get('/v1/models', async (_request, reply) => {
        try {
            // Fetch agents from Gateway
            // The method is agents.list or models.list? 
            // Based on hello-ok, 'models.list' and 'agents.list' are available.
            // OpenAI expects exact structure.

            const result = await client.request<{ agents: { id: string, name?: string }[] }>('agents.list');

            const data = result.agents.map(agent => ({
                id: agent.id,
                object: 'model',
                created: Date.now(),
                owned_by: 'openclaw',
                permission: []
            }));

            // Add default model if not present
            if (!data.find(d => d.id === config.defaultModel)) {
                data.push({
                    id: config.defaultModel,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'openclaw',
                    permission: []
                });
            }

            return {
                object: 'list',
                data
            };
        } catch (err) {
            throw err;
        }
    });

    // Health Check
    server.get('/health', async () => {
        return {
            status: 'ok',
            connected: client.isConnected,
            config: {
                gatewayUrl: config.gatewayUrl,
                agent: config.defaultModel
            }
        };
    });

    server.post('/v1/chat/completions', async (request, reply) => {
        const body = request.body as any;
        let model = body.model;
        const messages = body.messages as { role: string, content: string }[];
        const stream = body.stream === true;

        // Log unsupported parameters in verbose mode
        if (config.verbose) {
            const supported = ['model', 'messages', 'stream', 'user'];
            const ignored = Object.keys(body).filter(k => !supported.includes(k));
            if (ignored.length > 0) {
                server.log.warn(`Ignored unsupported parameters: ${ignored.join(', ')}`);
            }
        }

        if (!messages || messages.length === 0) {
            return reply.code(400).send({ error: { message: 'Messages are required', type: 'invalid_request_error' } });
        }

        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role !== 'user') {
            return reply.code(400).send({ error: { message: 'Last message must be from user', type: 'invalid_request_error' } });
        }

        // Determine Agent ID
        // If model is generic or empty, use default
        if (!model || model === 'gpt-3.5-turbo' || model === 'gpt-4') {
            model = config.defaultModel;
        }
        const agentId = model;

        // Create a completion ID
        const id = `chatcmpl-${Date.now()}`;

        // Note: We are treating this as a simple "send message" to the agent.
        // We are NOT forcing a full conversation history unless we need to sync it.
        // OpenClaw agents have their own memory. 
        // We will just send the user's latest message to the agent.

        if (stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');

            // Subscribe to agent events
            // Problem: How do we isolate THIS request's response?
            // OpenClaw's `agent` request returns a `runId`.
            // Events for that run will contain the `runId`.

            const sessionKey = `agent:${agentId}:main`; // Assuming main session

            // We need a way to correlate.
            // 1. Send 'agent' request. It returns { runId, status: 'accepted' }
            // 2. Listen for 'agent' events with that runId.

            let runId: string | null = null;

            const eventHandler = (evt: any) => {
                if (evt.event === 'agent' && evt.payload?.runId === runId) {
                    const payload = evt.payload;
                    if (payload.delta) {
                        const chunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model,
                            choices: [{
                                index: 0,
                                delta: { content: payload.delta },
                                finish_reason: null
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    if (payload.status === 'done' || payload.status === 'error') {
                        const finishReason = payload.status === 'error' ? 'stop' : 'stop'; // 'stop' usually
                        const chunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: finishReason
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        reply.raw.write('data: [DONE]\n\n');
                        // Clean up logic would be here if extended client supported unsubscription
                        reply.raw.end();
                    }
                }
            };

            // HACK: Multi-listener support needed in GatewayClient
            // Current GatewayClient.onEvent is a single callback.
            // We need to upgrade GatewayClient to be an EventEmitter or similar.
            // For MVP V0.1, we'll hacked it or upgrade it.
            // Let's assume we upgrade client first or just patch it here.

            // Upgrading on the fly:
            const originalOnEvent = client.onEvent;
            client.onEvent = (evt) => {
                if (originalOnEvent) originalOnEvent(evt);
                eventHandler(evt);
            };

            try {
                if (config.verbose) {
                    console.log('Sending agent request:', { agentId, message: lastMessage.content, sessionKey, idempotencyKey: id });
                }
                const res = await client.request<{ runId: string, status: string }>('agent', {
                    agentId,
                    message: lastMessage.content, // Provide raw content
                    sessionKey,
                    idempotencyKey: id
                });
                runId = res.runId;
            } catch (err: any) {
                server.log.error(err);
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: `Error: ${err.message || 'Unknown agent error'}` },
                        finish_reason: "stop"
                    }]
                };
                reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();
            }

        } else {
            // Non-streaming - wait for completion
            // Same logic but buffer.

            let fullContent = "";
            let runId: string | null = null;
            const sessionKey = `agent:${agentId}:main`;

            const donePromise = new Promise<void>((resolve, reject) => {
                const eventHandler = (evt: any) => {
                    if (evt.event === 'agent' && evt.payload?.runId === runId) {
                        if (evt.payload.delta) {
                            fullContent += evt.payload.delta;
                        }
                        if (evt.payload.status === 'done') {
                            resolve();
                        }
                        if (evt.payload.status === 'error') {
                            // If error, we still resolve to return what we have? 
                            // Or we can append error text.
                            fullContent += " [Error from Agent]";
                            resolve();
                        }
                    }
                };
                const originalOnEvent = client.onEvent;
                client.onEvent = (evt) => {
                    if (originalOnEvent) originalOnEvent(evt);
                    eventHandler(evt);
                };
            });

            if (config.verbose) {
                console.log('Sending agent request (non-stream):', { agentId, message: lastMessage.content, sessionKey, idempotencyKey: id });
            }
            try {
                const res = await client.request<{ runId: string, status: string }>('agent', {
                    agentId,
                    message: lastMessage.content,
                    sessionKey,
                    idempotencyKey: id
                });
                runId = res.runId;

                await donePromise;

                return {
                    id,
                    object: 'chat.completion',
                    created: Date.now(),
                    model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: fullContent
                        },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: 0,
                        completion_tokens: 0, // TODO: Count tokens?
                        total_tokens: 0
                    }
                };
            } catch (err) {
                throw err;
            }
        }
    });

    return server;
}
