import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayClient } from './lib/client';
import { type ClawProxyConfig } from './config';

export type ServerOptions = {
    port: number;
    host: string;
    gatewayUrl: string;
    gatewayToken?: string;
};

const ChatCompletionSchema = z.object({
    model: z.string().optional(),
    messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string(),
    })).min(1),
    stream: z.boolean().optional(),
    user: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    n: z.number().optional(),
    max_tokens: z.number().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    // Allow other optional fields but don't validate them strictly to avoid breaking clients sending extra params
}).passthrough();

export async function createServer(config: ClawProxyConfig): Promise<FastifyInstance> {
    const server = Fastify({
        logger: config.verbose ? { level: 'debug' } : { level: 'info' }
    });

    // Initialize Gateway Client
    const client = new GatewayClient({
        url: config.gatewayUrl,
        token: config.gatewayToken
    });

    client.on('error', (err) => {
        server.log.error(err, 'Gateway Client Error');
    });

    client.on('close', () => {
        server.log.warn('Gateway Client Disconnected');
    });

    // Connect to Gateway on startup
    try {
        await client.start();
        server.log.info('Connected to OpenClaw Gateway');

        // Log available agents - try/catch for safety
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
        const parseResult = ChatCompletionSchema.safeParse(request.body);

        if (!parseResult.success) {
            return reply.code(400).send({
                error: {
                    message: `Invalid request: ${parseResult.error.message}`,
                    type: 'invalid_request_error'
                }
            });
        }

        const body = parseResult.data;
        let model = body.model;
        const messages = body.messages;
        const stream = body.stream === true;
        const lastMessage = messages[messages.length - 1];

        // Determine Agent ID
        // If model is generic or empty, use default
        if (!model || model === 'gpt-3.5-turbo' || model === 'gpt-4') {
            model = config.defaultModel;
        }
        const agentId = model!;

        const id = `chatcmpl-${Date.now()}`;
        const sessionKey = `agent:${agentId}:main`;

        if (stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');

            let runId: string | null = null;

            const eventHandler = (evt: any) => {
                if (evt.event === 'agent' && evt.payload?.runId === runId) {
                    const payload = evt.payload;
                    if (payload.delta) {
                        const chunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model: agentId,
                            choices: [{
                                index: 0,
                                delta: { content: payload.delta },
                                finish_reason: null
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    if (payload.status === 'done' || payload.status === 'error') {
                        const finishReason = payload.status === 'error' ? 'stop' : 'stop';
                        const chunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model: agentId,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: finishReason
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        reply.raw.write('data: [DONE]\n\n');

                        // Cleanup listener
                        client.off('event', eventHandler);
                        reply.raw.end();
                    }
                }
            };

            // Register listener
            client.on('event', eventHandler);

            // Handle client disconnect to avoid leaks
            request.raw.on('close', () => {
                client.off('event', eventHandler);
            });

            try {
                if (config.verbose) {
                    server.log.debug({ agentId, sessionKey, id }, 'Sending agent request (stream)');
                }
                const res = await client.request<{ runId: string, status: string }>('agent', {
                    agentId,
                    message: lastMessage.content,
                    sessionKey,
                    idempotencyKey: id
                });
                runId = res.runId;
            } catch (err: any) {
                server.log.error(err);
                client.off('event', eventHandler); // Ensure cleanup on immediate error

                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: agentId,
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
            // Non-streaming
            let fullContent = "";
            let runId: string | null = null;

            const donePromise = new Promise<void>((resolve, reject) => {
                const eventHandler = (evt: any) => {
                    if (evt.event === 'agent' && evt.payload?.runId === runId) {
                        if (evt.payload.delta) {
                            fullContent += evt.payload.delta;
                        }
                        if (evt.payload.status === 'done') {
                            client.off('event', eventHandler);
                            resolve();
                        }
                        if (evt.payload.status === 'error') {
                            fullContent += " [Error from Agent]";
                            client.off('event', eventHandler);
                            resolve();
                        }
                    }
                };

                client.on('event', eventHandler);

                // Timeout safety for listener cleanup?
                // The client request timeout handles the initial request, but if agent hangs...
                // We'll rely on global timeout or user disconnect for now.
            });

            if (config.verbose) {
                server.log.debug({ agentId, sessionKey, id }, 'Sending agent request (non-stream)');
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
                    model: agentId,
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
                        completion_tokens: 0,
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
