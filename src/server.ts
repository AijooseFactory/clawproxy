import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { GatewayClient } from './lib/client';
import { StreamProcessor } from './lib/stream-processor';
import { mapSkillsToTools } from './lib/tools-handler';
import { type ClawProxyConfig } from './config';
import { type ApprovalRequest } from './lib/types';

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

    // Store pending approvals: sessionKey -> { runId, timestamp }
    const pendingApprovals = new Map<string, { runId: string, timestamp: number }>();

    // Session Map: localSessionKey -> { remoteSessionId, timestamp }
    const sessionMap = new Map<string, { remoteSessionId: string, timestamp: number }>();

    // Clean up stale pending approvals and sessions every hour
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        // Cleanup Pending Approvals (1 hour TTL)
        for (const [key, value] of pendingApprovals.entries()) {
            if (now - value.timestamp > 3600000) {
                pendingApprovals.delete(key);
                if (config.verbose) server.log.debug({ sessionKey: key }, 'Cleaned up stale pending approval');
            }
        }
        // Cleanup Session Map (24 hour TTL)
        for (const [key, value] of sessionMap.entries()) {
            if (now - value.timestamp > 86400000) { // 24 hours
                sessionMap.delete(key);
                if (config.verbose) server.log.debug({ sessionKey: key }, 'Cleaned up stale session map');
            }
        }
    }, 3600000);

    // Ensure interval is cleared on close
    server.addHook('onClose', (_instance, done) => {
        clearInterval(cleanupInterval);
        done();
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
        throw err;
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

    // Tools Endpoint (Dynamic Mapping)
    server.get('/v1/tools', async (request, reply) => {
        const { agentId } = request.query as { agentId?: string };
        const targetAgent = agentId || config.defaultModel;

        try {
            const skills = await client.fetchSkills(targetAgent);
            const tools = mapSkillsToTools(skills);
            return {
                object: 'list',
                data: tools
            };
        } catch (err: any) {
            server.log.warn({ err }, 'Failed to fetch tools');
            return {
                object: 'list',
                data: []
            };
        }
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
        // Ensure session is user-specific if provided, otherwise shared default
        const sessionKey = body.user ? `agent:${agentId}:${body.user}` : `agent:${agentId}:main`;

        // Smart Session Logic
        let sessionData = sessionMap.get(sessionKey);
        let remoteSessionId = sessionData?.remoteSessionId;

        // Is New Chat? (Standard heuristic: System + User or just User start)
        // If messages length is small, we assume it's a new conversation or a reset.
        // Or if we don't have a remoteSessionId yet.
        const isNewChat = messages.length <= 2 || !remoteSessionId;

        if (isNewChat) {
            remoteSessionId = randomUUID();
            sessionMap.set(sessionKey, { remoteSessionId, timestamp: Date.now() });
            if (config.verbose) server.log.info({ sessionKey, remoteSessionId }, 'Started new Smart Session');
        } else if (sessionData) {
            // Update timestamp on access to keep session alive
            sessionData.timestamp = Date.now();
        }

        const effectiveSessionId = remoteSessionId!;

        // Prepare Message Content based on Mode
        let messagePayload = "";

        if (config.sessionMode === 'stateful') {
            // Context Stripping: Only send the LAST message
            messagePayload = lastMessage.content;

            // Check for System Prompt on New Chat
            if (isNewChat) {
                const systemMsg = messages.find(m => m.role === 'system');
                if (systemMsg) {
                    messagePayload = `System: ${systemMsg.content}\n\nUser: ${messagePayload}`;
                }
            }

            if (config.verbose) server.log.debug('Mode: Stateful (Stripped context)');
        } else {
            // Passthrough: Send FULL formatted history
            // We format it as a string because OpenClaw Gateway 'agent' event typically expects a string message string
            // unless we update the protocol to support 'messages' array.
            // Following plan: Format as "ROLE: Content"
            messagePayload = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
            if (config.verbose) server.log.debug('Mode: Passthrough (Full history)');
        }

        // NOTE: We use 'effectiveSessionId' as the 'sessionKey' sent to OpenClaw
        // This ensures the agent sees a consistent persistent ID even if the user is stateless.

        if (stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');

            let runId: string | null = null;
            let isResuming = false;
            const streamProcessor = new StreamProcessor();

            // Check if we are approving a pending action
            if (pendingApprovals.has(sessionKey)) {
                const pending = pendingApprovals.get(sessionKey)!;
                // strict check for "APPROVE"
                if (lastMessage.content.trim().toUpperCase() === 'APPROVE') {
                    if (config.verbose) server.log.info({ sessionKey, runId: pending.runId }, 'User approved pending action');
                    pendingApprovals.delete(sessionKey);
                    runId = pending.runId;
                    isResuming = true;
                } else {
                    // User said something else. Depending on OpenClaw behavior, 
                    // this might be a new conversation turn or might need to cancel the previous run?
                    // For now, we assume sending a new message implicitly cancels or confuses the agent, 
                    // but we will proceed as a new run request unless it's strictly APPROVE.
                    // We'll clear the local pending state to avoid getting stuck.
                    if (config.verbose) server.log.info({ sessionKey }, 'User did not approve, clearing pending state');
                    pendingApprovals.delete(sessionKey);
                }
            }

            const eventHandler = (evt: any) => {
                // Match by RunID OR by SessionKey if we are still waiting for the RunID
                const isTargetRun = evt.payload?.runId === runId;
                const isTargetSession = runId === null && evt.payload?.sessionKey === sessionKey;

                if (evt.event === 'agent' && (isTargetRun || isTargetSession)) {

                    // Critical: If we matched by session, capture the runId now so we lock onto it
                    if (!runId && evt.payload?.runId) {
                        runId = evt.payload.runId;
                    }

                    const payload = evt.payload;

                    // Handle Confirmation Request
                    if (payload.status === 'requires_confirmation') {
                        if (config.verbose) server.log.info({ sessionKey, runId }, 'Agent requires confirmation');

                        const msg = "\n\n⚠️ **[SYSTEM NOTICE]** The agent needs your approval to proceed. Please reply with **APPROVE** to authorize the action.";
                        const chunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model: agentId,
                            choices: [{
                                index: 0,
                                delta: { content: msg },
                                finish_reason: null
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

                        // Store state
                        pendingApprovals.set(sessionKey, { runId: runId!, timestamp: Date.now() });

                        // End the stream so the user can reply
                        const finishChunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created: Date.now(),
                            model: agentId,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: 'stop'
                            }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                        reply.raw.write('data: [DONE]\n\n');

                        client.off('event', eventHandler);
                        reply.raw.end();
                        return;
                    }

                    if (payload.delta) {
                        // Process for thoughts
                        const { content, thought } = streamProcessor.process(payload.delta, payload.type);

                        // If we have content, send it
                        if (content) {
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Date.now(),
                                model: agentId,
                                choices: [{
                                    index: 0,
                                    delta: { content: content },
                                    finish_reason: null
                                }]
                            };
                            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }

                        // If we have thought, we could send it as a separate field if the client supports it (e.g. reasoning_content)
                        // Or we just swallow it to keep stability.
                        // Ideally we log it or send it as a comment if Debug mode?
                        if (thought && config.verbose) {
                            server.log.debug({ thought }, 'Agent Thought');
                        }
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
                if (isResuming && runId) {
                    if (config.verbose) {
                        server.log.debug({ agentId, sessionKey, runId }, 'Resuming agent run (approval)');
                    }
                    await client.approveRun(runId);
                    // No new runId, we keep the old one and just wait for events
                } else {
                    if (config.verbose) {
                        server.log.debug({ agentId, sessionKey, id }, 'Sending agent request (stream)');
                    }
                    // Use messagePayload and effectiveSessionId determined earlier
                    const res = await client.request<{ runId: string, status: string }>('agent', {
                        agentId,
                        message: messagePayload,
                        sessionKey: effectiveSessionId,
                        idempotencyKey: id
                    });
                    runId = res.runId;
                }
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
            let isResuming = false;

            // Check if we are approving a pending action (shared logic with streaming, but scoped locally here)
            if (pendingApprovals.has(sessionKey)) {
                const pending = pendingApprovals.get(sessionKey)!;
                if (lastMessage.content.trim().toUpperCase() === 'APPROVE') {
                    if (config.verbose) server.log.info({ sessionKey, runId: pending.runId }, 'User approved pending action (non-stream)');
                    pendingApprovals.delete(sessionKey);
                    runId = pending.runId;
                    isResuming = true;
                } else {
                    if (config.verbose) server.log.info({ sessionKey }, 'User did not approve, clearing pending state');
                    pendingApprovals.delete(sessionKey);
                }
            }

            const donePromise = new Promise<void>((resolve, reject) => {
                // Timeout to prevent hanging indefinitely
                const timer = setTimeout(() => {
                    client.off('event', eventHandler);
                    reject(new Error("Agent execution timed out"));
                }, 60000); // 60s timeout

                const eventHandler = (evt: any) => {
                    // Match by RunID OR by SessionKey if we are still waiting for the RunID
                    const isTargetRun = evt.payload?.runId === runId;
                    const isTargetSession = runId === null && evt.payload?.sessionKey === sessionKey;

                    if (evt.event === 'agent' && (isTargetRun || isTargetSession)) {

                        // Critical: If we matched by session, capture the runId now so we lock onto it
                        if (!runId && evt.payload?.runId) {
                            runId = evt.payload.runId;
                        }

                        if (evt.payload.delta) {
                            fullContent += evt.payload.delta;
                        }
                        if (evt.payload.status === 'requires_confirmation') {
                            if (config.verbose) server.log.info({ sessionKey, runId }, 'Agent requires confirmation (non-stream)');
                            fullContent = "\n\n⚠️ **[SYSTEM NOTICE]** The agent needs your approval to proceed. Please reply with **APPROVE** to authorize the action.";
                            pendingApprovals.set(sessionKey, { runId: runId!, timestamp: Date.now() });
                            clearTimeout(timer);
                            client.off('event', eventHandler);
                            resolve();
                        }
                        if (evt.payload.status === 'done') {
                            clearTimeout(timer);
                            client.off('event', eventHandler);
                            resolve();
                        }
                        if (evt.payload.status === 'error') {
                            fullContent += " [Error from Agent]";
                            clearTimeout(timer);
                            client.off('event', eventHandler);
                            resolve();
                        }
                    }
                };

                client.on('event', eventHandler);

                // Handle client disconnect to avoid leaks
                request.raw.on('close', () => {
                    clearTimeout(timer);
                    client.off('event', eventHandler);
                });
            });

            if (config.verbose) {
                server.log.debug({ agentId, sessionKey, id }, 'Sending agent request (non-stream)');
            }

            try {
                if (isResuming && runId) {
                    if (config.verbose) {
                        server.log.debug({ agentId, sessionKey, runId }, 'Resuming agent run (approval) - non-stream');
                    }
                    await client.approveRun(runId);
                    await donePromise;
                } else {
                    const res = await client.request<{ runId: string, status: string }>('agent', {
                        agentId,
                        message: messagePayload,
                        sessionKey: effectiveSessionId,
                        idempotencyKey: id
                    });
                    runId = res.runId;

                    await donePromise;
                }

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
            } catch (err: any) {
                // Map specific gateway errors to 400
                if (err.message && (err.message.includes('unknown agent') || err.message.includes('invalid agent'))) {
                    return reply.code(400).send({
                        error: {
                            message: err.message,
                            type: 'invalid_request_error',
                            code: 'model_not_found'
                        }
                    });
                }
                throw err;
            }
        }
    });

    return server;
}
