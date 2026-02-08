import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { GatewayClient } from './lib/client';
import { mapSkillsToTools } from './lib/tools-handler';
import { type ClawProxyConfig } from './config';
import { type ApprovalRequest } from './lib/types';
import cors from '@fastify/cors';
import { PassThrough } from 'stream';
import { ReasoningStreamProcessor } from './lib/stream-processor';

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

const LIVE_STATE_PATTERNS = [
    /\b(?:show|list|count|how many|what (?:is|are)|where (?:is|are)|exists|tree|current|right now|on disk)\b.*?\b(?:files|folders|workspace|structure|directory|root|folders|terminal|current state)\b/i,
    /\b(?:ls|find|grep|cat|read|edit|write|exec)\b/i,
    /\blive state\b/i
];

const RAG_MARKERS = [
    /\[Sources:\][\s\S]*?(\[End Sources\]|$)/gi,
    /\bSources?:\s*[\s\S]*?(?:\n\n|$)/gi,
    /\bSources?:\s*\(\d+\)[\s\S]*?(?:\n\n|$)/gi,
    /\bSources?\s*\(\d+\):?[\s\S]*?(?:\n\n|$)/gi,
    /\bCitations?:\s*[\s\S]*?(?:\n\n|$)/gi,
    /Use the (?:following|provided) context to answer the question:?[\s\S]*?(?:\n\n|$)/gi,
    /(?:Retrieved|File) context:?[\s\S]*?(?:\n\n|$)/gi,
    /Knowledge from documents:?[\s\S]*?(?:\n\n|$)/gi,
    /Contextual information follows:?[\s\S]*?(?:\n\n|$)/gi,
    /Refer to the (?:following|provided) search results:?[\s\S]*?(?:\n\n|$)/gi,
    /\bRelevant documents:?[\s\S]*?(?:\n\n|$)/gi,
    /\bInformation from (?:the )?knowledge base:?[\s\S]*?(?:\n\n|$)/gi,
    /^\d+\s+Sources?$/gm,
    /\b\d+\s+Sources?$/g
];

function stripRAG(text: string): string {
    if (!text) return text;
    let cleaned = text;
    RAG_MARKERS.forEach(regex => {
        if (regex.test(cleaned)) {
            console.log(`[Advanced Interceptor] Matched RAG pattern: ${regex}`);
            cleaned = cleaned.replace(regex, '');
        }
    });
    return cleaned.trim();
}

function detectIntent(messages: { role: string, content: string }[]): boolean {
    const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return false;
    const match = LIVE_STATE_PATTERNS.some(regex => regex.test(lastUserMsg.content));
    if (match) {
        console.log(`[Advanced Interceptor] LIVE_STATE detected: "${lastUserMsg.content.substring(0, 50)}..."`);
    }
    return match;
}

const SYSTEM_GUARD_TEXT = "LIVE_STATE: Tools are authoritative. Skip explanations. Execute workspace tools now.";

function advancedSanitize(messages: { role: 'system' | 'user' | 'assistant' | 'tool', content: string }[]): { role: 'system' | 'user' | 'assistant' | 'tool', content: string }[] {
    const isLiveState = detectIntent(messages);
    const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
    const isForceKnowledge = lastUserMsg?.content.includes('#');

    if (isLiveState) {
        console.log(`[Advanced Interceptor] Processing ${messages.length} messages with LIVE_STATE authority...`);
    }

    let sanitized = messages.map(m => {
        if (m.role === 'tool') return m; // Safeguard tool results/outputs

        if (isLiveState) {
            const clean = stripRAG(m.content);
            if (clean !== m.content) {
                console.log(`[Advanced Interceptor] Stripped RAG from ${m.role} message (len: ${m.content.length} -> ${clean.length})`);
            }
            return { ...m, content: clean };
        }
        return m;
    });

    if (isLiveState) {
        sanitized.unshift({
            role: 'system',
            content: SYSTEM_GUARD_TEXT
        });
    }
    return sanitized;
}

const FORBIDDEN_FIELDS = ['follow_ups', 'metadata', 'tool_output', 'actions', 'usage', 'runId', 'sessionKey'];

function normalizeDeltaPayload(delta: unknown): Record<string, unknown> {
    if (delta === null || delta === undefined) {
        return {};
    }
    if (typeof delta === 'string') {
        return { content: delta };
    }
    if (typeof delta === 'object') {
        const out = { ...delta as Record<string, unknown> };
        // Strip internal fields to prevent leakage
        FORBIDDEN_FIELDS.forEach(f => delete out[f]);
        return out;
    }
    return { content: String(delta) };
}

export async function createServer(config: ClawProxyConfig): Promise<FastifyInstance> {
    const server = Fastify({
        logger: config.verbose ? { level: 'debug' } : { level: 'info' }
    });

    await server.register(cors, {
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS']
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
    }, 3600000).unref();

    // Ensure interval and client are cleared on close
    server.addHook('onClose', (_instance, done) => {
        clearInterval(cleanupInterval);
        client.stop();
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

    // Connect to Gateway on startup (in background)
    client.start().then(() => {
        server.log.info('Connected to OpenClaw Gateway');

        // Log available agents
        client.request<{ agents: { id: string, name?: string }[] }>('agents.list')
            .then(result => {
                const agentNames = result.agents.map(a => `${a.name || a.id} (${a.id})`).join(', ');
                server.log.info(`Available Agents: ${agentNames}`);
            })
            .catch(err => {
                server.log.warn('Failed to fetch initial agent list');
            });
    }).catch(err => {
        // This catch might not be reached if connectWithRetry loops forever, 
        // but it's good practice.
        server.log.error(err, 'Gateway connection failed (background)');
    });

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
        const streamRequest = body.stream === true;
        const lastMessage = messages[messages.length - 1];

        // Determine Agent ID
        if (!model || model === 'gpt-3.5-turbo' || model === 'gpt-4') {
            model = config.defaultModel;
        }
        const agentId = model!;

        const id = `chatcmpl-${Date.now()}`;
        const sessionKey = body.user ? `agent:${agentId}:${body.user}` : `agent:${agentId}:main`;

        // Session Logic
        let sessionData = sessionMap.get(sessionKey);
        let remoteSessionId = sessionData?.remoteSessionId;

        const isNewChat = messages.length <= 2 || !remoteSessionId;

        if (isNewChat) {
            remoteSessionId = randomUUID();
            sessionMap.set(sessionKey, { remoteSessionId, timestamp: Date.now() });
            if (config.verbose) server.log.info({ sessionKey, remoteSessionId }, 'Started new Smart Session');
        } else if (sessionData) {
            sessionData.timestamp = Date.now();
        }

        const effectiveSessionId = remoteSessionId!;
        let messagePayload = "";

        if (config.sessionMode === 'stateful') {
            messagePayload = lastMessage.content;
            if (isNewChat) {
                const systemMsg = messages.find(m => m.role === 'system');
                if (systemMsg) {
                    messagePayload = `System: ${systemMsg.content}\n\nUser: ${messagePayload}`;
                }
            }
        } else {
            messagePayload = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }

        // Apply Advanced Intent Interceptor to bypass RAG hijacking
        // For stateful mode, we currently process a single string payload. 
        // To support multi-message stripping as requested, we process the history first.
        const processedMessages = advancedSanitize(messages as any);

        // Update messagePayload based on sanitized history
        if (config.sessionMode === 'stateful') {
            const lastUser = processedMessages.filter(m => m.role === 'user').pop();
            const guard = processedMessages.find(m => m.role === 'system' && m.content === SYSTEM_GUARD_TEXT);
            const baseSystem = processedMessages.find(m => m.role === 'system' && m.content !== SYSTEM_GUARD_TEXT);

            messagePayload = lastUser?.content || lastMessage.content;

            if (isNewChat) {
                const parts = [];
                if (guard) parts.push(guard.content);
                if (baseSystem) parts.push(baseSystem.content);
                if (parts.length > 0) {
                    messagePayload = `System: ${parts.join('\n\n')}\n\nUser: ${messagePayload}`;
                }
            } else if (guard) {
                // Reinforce guard for subsequent turns in stateful mode
                messagePayload = `(System: ${guard.content}) ${messagePayload}`;
            }
        }
        else {
            messagePayload = processedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }

        if (streamRequest) {
            reply.header('Content-Type', 'text/event-stream');
            reply.header('Cache-Control', 'no-cache');
            reply.header('Connection', 'keep-alive');
            reply.header('X-Accel-Buffering', 'no');

            const stream = new PassThrough();
            reply.send(stream);

            const processor = new ReasoningStreamProcessor();

            let runId: string | null = null;
            let isResuming = false;
            let listenerRemoved = false;

            const writeSseChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
                const chunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: agentId,
                    choices: [{
                        index: 0,
                        delta,
                        finish_reason: finishReason
                    }]
                };
                stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
            };

            let assistantRoleSent = false;
            const sendAssistantRoleChunk = () => {
                if (assistantRoleSent) return;
                assistantRoleSent = true;
                writeSseChunk({ role: 'assistant' });
            };

            const sendContentChunk = (text?: string | null) => {
                if (!text && text !== "") return;
                sendAssistantRoleChunk();
                writeSseChunk({ content: text });
            };

            const forwardDelta = (raw: unknown) => {
                const normalized = normalizeDeltaPayload(raw);
                if (Object.keys(normalized).length === 0) return;

                const processed = processor.processDelta(normalized);
                if (!processed.content && !processed.role) return;

                sendAssistantRoleChunk();
                writeSseChunk(processed);
            };

            // Check if we are approving a pending action
            if (pendingApprovals.has(sessionKey)) {
                const pending = pendingApprovals.get(sessionKey)!;
                if (lastMessage.content.trim().toUpperCase() === 'APPROVE') {
                    if (config.verbose) server.log.info({ sessionKey, runId: pending.runId }, 'User approved pending action');
                    pendingApprovals.delete(sessionKey);
                    runId = pending.runId;
                    isResuming = true;
                } else {
                    if (config.verbose) server.log.info({ sessionKey }, 'User did not approve, clearing pending state');
                    pendingApprovals.delete(sessionKey);
                }
            }

            const eventHandler = (evt: any) => {
                const isTargetRun = evt.payload?.runId === runId;
                const isTargetSession = runId === null && evt.payload?.sessionKey === effectiveSessionId;

                if (evt.event === 'agent' && (isTargetRun || isTargetSession)) {
                    if (!runId && evt.payload?.runId) {
                        runId = evt.payload.runId;
                    }

                    const payload = evt.payload;

                    if (payload.status === 'requires_confirmation') {
                        if (config.verbose) server.log.info({ sessionKey, runId }, 'Agent requires confirmation');
                        const msg = "\n\n⚠️ **[SYSTEM NOTICE]** The agent needs your approval to proceed. Please reply with **APPROVE** to authorize the action.";
                        sendContentChunk(msg);
                        pendingApprovals.set(sessionKey, { runId: runId!, timestamp: Date.now() });
                        writeSseChunk({}, 'stop');
                        stream.write('data: [DONE]\n\n');
                        if (!listenerRemoved) {
                            listenerRemoved = true;
                            client.off('event', eventHandler);
                        }
                        stream.end();
                        return;
                    }

                    if (payload.stream === 'assistant' && payload.data?.delta !== undefined) {
                        forwardDelta(payload.data.delta);

                    } else if (payload.delta !== undefined) {
                        forwardDelta(payload.delta);
                    }

                    const isLifecycleEnd = payload.stream === 'lifecycle' && payload.data?.phase === 'end';
                    const isLifecycleError = payload.stream === 'lifecycle' && payload.data?.phase === 'error';
                    const isStatusDone = payload.status === 'done';
                    const isStatusError = payload.status === 'error';

                    if (isLifecycleEnd || isStatusDone || isLifecycleError || isStatusError) {
                        sendAssistantRoleChunk();
                        writeSseChunk({}, 'stop');
                        stream.write('data: [DONE]\n\n');

                        if (!listenerRemoved) {
                            listenerRemoved = true;
                            client.off('event', eventHandler);
                        }
                        stream.end();
                    }
                }
            };

            client.on('event', eventHandler);

            stream.on('close', () => {
                if (!listenerRemoved) {
                    listenerRemoved = true;
                    client.off('event', eventHandler);
                }
            });

            (async () => {
                try {
                    if (isResuming && runId) {
                        await client.approveRun(runId);
                    } else {
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
                    client.off('event', eventHandler);
                    sendAssistantRoleChunk();
                    writeSseChunk({ content: `Error: ${err.message || 'Unknown agent error'}` }, 'stop');
                    stream.write('data: [DONE]\n\n');
                    stream.end();
                }
            })();

            return reply;

        } else {
            // Non-streaming
            const processor = new ReasoningStreamProcessor();
            let fullContent = "";
            let fullReasoning = "";
            let runId: string | null = null;
            let isResuming = false;

            const appendDeltaText = (delta: unknown) => {
                const normalized = normalizeDeltaPayload(delta);
                if (normalized.content) {
                    fullContent += normalized.content;
                }
                if (normalized.reasoning_content) {
                    fullReasoning += String(normalized.reasoning_content);
                }
                if (normalized.thinking) {
                    fullReasoning += String(normalized.thinking);
                }
                if (normalized.thought) {
                    fullReasoning += String(normalized.thought);
                }
            };

            if (pendingApprovals.has(sessionKey)) {
                const pending = pendingApprovals.get(sessionKey)!;
                if (lastMessage.content.trim().toUpperCase() === 'APPROVE') {
                    pendingApprovals.delete(sessionKey);
                    runId = pending.runId;
                    isResuming = true;
                } else {
                    pendingApprovals.delete(sessionKey);
                }
            }

            const donePromise = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    client.off('event', eventHandler);
                    reject(new Error("Agent execution timed out"));
                }, 60000);

                const eventHandler = (evt: any) => {
                    const isTargetRun = evt.payload?.runId === runId;
                    const isTargetSession = runId === null && evt.payload?.sessionKey === effectiveSessionId;

                    if (evt.event === 'agent' && (isTargetRun || isTargetSession)) {
                        if (!runId && evt.payload?.runId) {
                            runId = evt.payload.runId;
                        }

                        if (evt.payload.status === 'requires_confirmation') {
                            fullContent = "\n\n⚠️ **[SYSTEM NOTICE]** The agent needs your approval to proceed. Please reply with **APPROVE** to authorize the action.";
                            pendingApprovals.set(sessionKey, { runId: runId!, timestamp: Date.now() });
                            clearTimeout(timer);
                            client.off('event', eventHandler);
                            resolve();
                            return;
                        }

                        const p = evt.payload;
                        if (p.stream === 'assistant' && p.data?.delta !== undefined) {
                            appendDeltaText(p.data.delta);
                        }

                        if (p.delta !== undefined) {
                            appendDeltaText(p.delta);
                        }

                        const isEnd = (p.stream === 'lifecycle' && p.data?.phase === 'end') || p.status === 'done';
                        const isError = (p.stream === 'lifecycle' && p.data?.phase === 'error') || p.status === 'error';

                        if (isEnd || isError) {
                            if (isError) fullContent += " [Error from Agent]";
                            clearTimeout(timer);
                            client.off('event', eventHandler);
                            resolve();
                        }
                    }
                };

                client.on('event', eventHandler);
            });

            try {
                if (isResuming && runId) {
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
                            content: processor.processFullResponse(fullContent, fullReasoning)
                        },
                        finish_reason: 'stop'
                    }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };
            } catch (err: any) {
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
