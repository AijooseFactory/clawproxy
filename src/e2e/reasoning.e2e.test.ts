
import { createServer } from '../server';
import { ReasoningMockGateway } from './reasoning-mock-gateway';
import { type FastifyInstance } from 'fastify';

describe('Reasoning Interceptor E2E', () => {
    jest.setTimeout(60000);
    let mockGateway: ReasoningMockGateway;
    let server: FastifyInstance;
    let PORT: number;
    let GATEWAY_PORT: number;

    beforeAll(async () => {
        console.log('E2E: Starting mock gateway...');
        // Use a fixed port for mock gateway to be more stable
        GATEWAY_PORT = 19123;
        mockGateway = new ReasoningMockGateway(GATEWAY_PORT);
        await mockGateway.start();
        console.log(`E2E: Mock gateway listening on ${GATEWAY_PORT}`);

        server = await createServer({
            httpPort: 0,
            httpHost: '127.0.0.1',
            gatewayUrl: `ws://127.0.0.1:${GATEWAY_PORT}`,
            verbose: true,
            sessionMode: 'stateful',
            defaultModel: 'reasoning-agent'
        });

        await server.listen({ port: 0, host: '127.0.0.1' });
        const addr: any = server.server.address();
        PORT = addr.port;
        console.log(`E2E: ClawProxy listening on ${PORT}`);
        // Give ClawProxy a moment to connect to mock gateway
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    afterAll(async () => {
        await server.close();
        await mockGateway.stop();
    });

    it('should transform reasoning stream into <think> tags and strip fields', async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'reasoning-agent',
                messages: [{ role: 'user', content: 'Tell me something.' }],
                stream: true
            })
        });

        if (!response.body) throw new Error('No response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let fullText = '';
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
                        const delta = data.choices[0].delta;
                        receivedDeltas.push(delta);
                        if (delta.content) {
                            fullText += delta.content;
                        }
                    } catch (e) {
                        console.error('Failed to parse SSE chunk:', line);
                    }
                }
            }
        }

        console.log('Full transformed text:', fullText);

        // Verify tags are injected with correct formatting
        expect(fullText).toContain('<think>I am thinking');
        expect(fullText).toContain('deeply...</think>\n\nHello!');

        // Verify field stripping: none of the deltas should contain reasoning_content or thinking
        for (const delta of receivedDeltas) {
            expect(delta.reasoning_content).toBeUndefined();
            expect(delta.thinking).toBeUndefined();
            expect(delta.thought).toBeUndefined();
        }
    });

    it('should handle non-streaming reasoning transformation', async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'reasoning-agent',
                messages: [{ role: 'user', content: 'Tell me something.' }],
                stream: false
            })
        });

        const data: any = await response.json();
        const content = data.choices[0].message.content;
        expect(content).toContain('<think>I am thinking deeply...</think>\n\nHello!');
    }, 10000);

    it('should bail out if native <think> tags are detected in content', async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'native-thinking-agent',
                messages: [{ role: 'user', content: 'Tell me something.' }],
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

        // It should contain exactly one set of tags (the native ones)
        const occurrences = (fullText.match(/<think>/g) || []).length;
        expect(occurrences).toBe(1);
        expect(fullText).toContain('<think>Native thinking</think> Response content');
    });
});
