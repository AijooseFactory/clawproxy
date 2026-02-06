
import Link from 'ws';
const { WebSocketServer } = Link;
import { randomUUID } from 'crypto';

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

export class MockGateway {
    private wss: any = null;
    private port: number;

    constructor(port: number = 19001) {
        this.port = port;
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.wss = new WebSocketServer({ port: this.port });

            this.wss.on('connection', (ws: any) => {
                console.log('MockGateway: Client connected');

                // 1. Send Challenge
                const challenge: JsonMessage = {
                    type: 'event',
                    event: 'connect.challenge',
                    payload: { nonce: randomUUID() }
                };
                ws.send(JSON.stringify(challenge));

                ws.on('message', (data: any) => {
                    console.log('MockGateway: Received message', data.toString());
                    try {
                        const msg: JsonMessage = JSON.parse(data.toString());
                        this.handleMessage(ws, msg);
                    } catch (e) {
                        console.error('MockGateway: Failed to parse message', e);
                    }
                });

                ws.on('error', (err: any) => {
                    console.error('MockGateway: WebSocket error', err);
                });
            });

            this.wss.on('listening', () => {
                console.log(`MockGateway: Listening on ${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.wss) {
                // Force close all clients
                this.wss.clients.forEach((client: any) => {
                    client.terminate();
                });

                this.wss.close((err: any) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private handleMessage(ws: WebSocket, msg: JsonMessage) {
        // Handle Request Response
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
                    // Just accept any connection
                    sendRes({
                        server: { version: '0.0.0-mock' }
                    });
                    break;

                case 'agents.list':
                    console.log('MockGateway: Handling agents.list request');
                    sendRes({
                        agents: [
                            { id: 'mock-agent', name: 'Mock Agent' }
                        ]
                    });
                    break;

                case 'agent.skills':
                    sendRes([]);
                    break;

                case 'agent':
                    // Start Agent Run
                    const params = msg.params || {};
                    const agentId = params.agentId;

                    if (agentId !== 'mock-agent' && agentId !== 'dev') {
                        console.log(`MockGateway: Rejecting invalid agent ${agentId}`);
                        const res: JsonMessage = {
                            type: 'res',
                            id: msg.id,
                            ok: false,
                            error: { message: `unknown agent: ${agentId}` }
                        };
                        ws.send(JSON.stringify(res));
                        return;
                    }

                    const runId = randomUUID();
                    // 1. Acknowledge start
                    sendRes({ runId, status: 'starting' });

                    // 2. Stream content
                    // Simulate a small delay then send content
                    setTimeout(() => {
                        // Delta 1
                        sendEvent('agent', {
                            runId,
                            stream: 'assistant',
                            data: { delta: 'Hello from Mock! ' }
                        });

                        // Delta 2
                        setTimeout(() => {
                            sendEvent('agent', {
                                runId,
                                stream: 'assistant',
                                data: { delta: 'Tests are working.' }
                            });

                            // End
                            setTimeout(() => {
                                sendEvent('agent', {
                                    runId,
                                    stream: 'lifecycle',
                                    data: { phase: 'end' }
                                });
                            }, 50);
                        }, 50);
                    }, 50);
                    break;

                default:
                    console.warn('MockGateway: Unknown method', msg.method);
                    sendRes({});
            }
        }
    }
}
