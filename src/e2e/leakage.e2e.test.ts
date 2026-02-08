
import { createServer } from '../server';
import { ReasoningMockGateway } from './reasoning-mock-gateway';
import { type FastifyInstance } from 'fastify';

describe('Instruction Leakage Prevention E2E', () => {
    jest.setTimeout(60000);
    let mockGateway: ReasoningMockGateway;
    let server: FastifyInstance;
    let PORT: number;
    let GATEWAY_PORT: number;

    beforeAll(async () => {
        GATEWAY_PORT = 19124;
        mockGateway = new ReasoningMockGateway(GATEWAY_PORT);
        await mockGateway.start();

        server = await createServer({
            httpPort: 0,
            httpHost: '127.0.0.1',
            gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
            verbose: true,
            sessionMode: 'stateful',
            defaultModel: 'leakage-agent'
        });

        await server.listen({ port: 0, host: '127.0.0.1' });
        const addr: any = server.server.address();
        PORT = addr.port;
        // Wait for gateway connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    afterAll(async () => {
        await server.close();
        await mockGateway.stop();
    });

    it('should filter out blocked internal fields from SSE stream', async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'leakage-agent',
                messages: [{ role: 'user', content: 'Test leakage.' }],
                stream: true
            })
        });

        if (!response.body) throw new Error('No response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let receivedDeltas: any[] = [];
        let done = false;

        while (!done) {
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        receivedDeltas.push(data.choices[0].delta);
                    } catch (e) { }
                }
            }
        }

        // Verify that internal fields like 'follow_ups' are NOT in the deltas
        // Note: The mock gateway must be configured to send these fields for this test to be meaningful
        for (const delta of receivedDeltas) {
            expect(delta.follow_ups).toBeUndefined();
            expect(delta.tool_output).toBeUndefined();
            expect(delta.metadata).toBeUndefined();
        }
    });

    it('should NOT suppress raw JSON leakage in content stream (pass-thru behavior)', async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'leakage-agent',
                messages: [{ role: 'user', content: 'trigger-json-leak' }],
                stream: true
            })
        });

        if (!response.body) throw new Error('No response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let fullText = '';
        let done = false;

        while (!done) {
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.choices[0].delta.content) {
                            fullText += data.choices[0].delta.content;
                        }
                    } catch (e) { }
                }
            }
        }

        // We now EXPECT this to be passed through because the user wants "pass-thru" behavior
        // But we rely on the hardened System Prompt to actually prevent the agent from doing this.
        expect(fullText).toContain('follow_up');
    });
});
