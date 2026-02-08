
import { randomUUID } from 'crypto';
import Link from 'ws';
const { WebSocketServer } = Link;

interface JsonMessage {
    type: 'req' | 'res' | 'event';
    id?: string;
    method?: string;
    params?: any;
    event?: string;
    payload?: any;
    ok?: boolean;
    error?: any;
}

export class ReasoningMockGateway {
    private wss: any = null;
    private port: number;

    constructor(port: number = 19001) {
        this.port = port;
    }

    getPort(): number {
        return this.port;
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.wss = new WebSocketServer({ port: this.port });

            this.wss.on('connection', (ws: any) => {
                // 1. Send Challenge
                const challenge: JsonMessage = {
                    type: 'event',
                    event: 'connect.challenge',
                    payload: { nonce: randomUUID() }
                };
                ws.send(JSON.stringify(challenge));

                ws.on('message', (data: any) => {
                    try {
                        const msg: JsonMessage = JSON.parse(data.toString());
                        this.handleMessage(ws, msg);
                    } catch (e) {
                        console.error('ReasoningMockGateway: Failed to parse message', e);
                    }
                });
            });

            this.wss.on('listening', () => {
                console.log(`ReasoningMockGateway: Listening on ${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.wss) {
                this.wss.clients.forEach((client: any) => client.terminate());
                this.wss.close((err: any) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private handleMessage(ws: any, msg: JsonMessage) {
        const sendRes = (payload: any) => {
            const res: JsonMessage = {
                type: 'res',
                id: msg.id,
                ok: true,
                payload
            };
            ws.send(JSON.stringify(res));
        };

        const sendEvent = (event: string, payload: any) => {
            const evt: JsonMessage = {
                type: 'event',
                event,
                payload
            };
            ws.send(JSON.stringify(evt));
        };

        if (msg.type === 'req') {
            switch (msg.method) {
                case 'connect':
                    sendRes({ server: { version: '0.0.0-mock' } });
                    break;
                case 'agents.list':
                    sendRes({ agents: [{ id: 'reasoning-agent', name: 'Reasoning Agent' }] });
                    break;
                case 'agent.skills':
                    sendRes([]);
                    break;
                case 'agent':
                    console.log('ReasoningMockGateway: Received agent request');
                    const runId = randomUUID();
                    const targetAgent = msg.params?.agentId;
                    sendRes({ runId, status: 'starting' });

                    if (targetAgent === 'native-thinking-agent') {
                        // Simulate native thinking
                        setTimeout(() => {
                            sendEvent('agent', {
                                runId,
                                stream: 'assistant',
                                data: { delta: { content: '<think>Native thinking' } }
                            });
                            setTimeout(() => {
                                sendEvent('agent', {
                                    runId,
                                    stream: 'assistant',
                                    data: { delta: { content: '</think> Response content' } }
                                });
                                setTimeout(() => {
                                    sendEvent('agent', {
                                        runId,
                                        stream: 'lifecycle',
                                        data: { phase: 'end' }
                                    });
                                }, 50);
                            }, 50);
                        }, 50);
                    } else if (targetAgent === 'leakage-agent') {
                        const rawMsg = msg.params?.message;
                        const isTriggerJson = typeof rawMsg === 'string'
                            ? rawMsg.includes('trigger-json-leak')
                            : rawMsg?.messages?.some((m: any) => m.content === 'trigger-json-leak');

                        setTimeout(() => {
                            if (isTriggerJson) {
                                // Simulate raw JSON leak in content
                                sendEvent('agent', {
                                    runId,
                                    stream: 'assistant',
                                    data: { delta: { content: '{"follow_up": "leak", "action": "testing"}' } }
                                });
                            } else {
                                // Simulate metadata leakage in fields
                                sendEvent('agent', {
                                    runId,
                                    stream: 'assistant',
                                    data: {
                                        delta: {
                                            content: 'Normal text',
                                            follow_ups: ['leaked-followup'],
                                            metadata: { secret: 'leak' }
                                        }
                                    }
                                });
                            }

                            setTimeout(() => {
                                sendEvent('agent', {
                                    runId,
                                    stream: 'lifecycle',
                                    data: { phase: 'end' }
                                });
                            }, 50);
                        }, 50);
                    } else if (targetAgent === 'cumulative-agent') {
                        // Simulate cumulative stream (the bug source)
                        setTimeout(() => {
                            sendEvent('agent', {
                                runId,
                                stream: 'assistant',
                                data: { delta: { content: 'G' } }
                            });
                            setTimeout(() => {
                                sendEvent('agent', {
                                    runId,
                                    stream: 'assistant',
                                    data: { delta: { content: 'GE' } }
                                });
                                setTimeout(() => {
                                    sendEvent('agent', {
                                        runId,
                                        stream: 'assistant',
                                        data: { delta: { content: 'GEM' } }
                                    });
                                    setTimeout(() => {
                                        sendEvent('agent', {
                                            runId,
                                            stream: 'lifecycle',
                                            data: { phase: 'end' }
                                        });
                                    }, 50);
                                }, 50);
                            }, 50);
                        }, 50);
                    } else {
                        // Simulate reasoning stream
                        setTimeout(() => {
                            // 1. Thinking starts
                            sendEvent('agent', {
                                runId,
                                stream: 'assistant',
                                data: { delta: { reasoning_content: 'I am thinking' } }
                            });

                            // 2. Thinking continues
                            setTimeout(() => {
                                sendEvent('agent', {
                                    runId,
                                    stream: 'assistant',
                                    data: { delta: { thinking: ' deeply...' } }
                                });

                                // 3. Content follows
                                setTimeout(() => {
                                    sendEvent('agent', {
                                        runId,
                                        stream: 'assistant',
                                        data: { delta: { content: 'Hello!' } }
                                    });

                                    // 4. End
                                    setTimeout(() => {
                                        sendEvent('agent', {
                                            runId,
                                            stream: 'lifecycle',
                                            data: { phase: 'end' }
                                        });
                                    }, 50);
                                }, 50);
                            }, 50);
                        }, 50);
                    }
                    break;
                default:
                    sendRes({});
            }
        }
    }
}
