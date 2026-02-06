
import { createServer } from '../server';
import { ClawProxyConfig } from '../config';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { FastifyInstance } from 'fastify';
import { MockGateway } from './mock-gateway';

const GATEWAY_URL = 'ws://127.0.0.1:19001';
// Token from env
const GATEWAY_TOKEN = process.env.CLAWPROXY_GATEWAY_TOKEN;

describe('E2E: ClawProxy -> OpenClaw Gateway', () => {
    let server: FastifyInstance;
    let agentId: string;
    let mockGateway: MockGateway;

    const config: ClawProxyConfig = {
        gatewayUrl: GATEWAY_URL,
        gatewayToken: GATEWAY_TOKEN,
        httpPort: 0,
        httpHost: '127.0.0.1',
        defaultModel: 'dev',
        verbose: true, // Enable logs for debug
        sessionMode: 'passthrough'
    };

    beforeAll(async () => {
        // Start Mock Gateway
        mockGateway = new MockGateway(19001);
        await mockGateway.start();

        console.log('Starting E2E Server connecting to:', GATEWAY_URL);
        server = await createServer(config);
        await server.ready();

        // Wait for gateway connection
        let retries = 0;
        while (retries < 20) {
            const res = await server.inject({ method: 'GET', url: '/health' });
            const health = JSON.parse(res.payload);
            if (health.connected) {
                console.log('E2E: Gateway connected successfully');
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            retries++;
        }
        if (retries >= 20) throw new Error('Failed to connect to Mock Gateway');
    });

    afterAll(async () => {
        await server.close();
        await mockGateway.stop();
    });

    it('should list models from the real gateway', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/v1/models'
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.object).toBe('list');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);

        // Log full models found
        console.log('Models found (full):', JSON.stringify(body.data, null, 2));

        // Use 'main' if available, otherwise first non-dev
        const mainAgent = body.data.find((d: any) => d.id === 'main');
        if (mainAgent) {
            agentId = 'main';
        } else {
            const other = body.data.find((d: any) => d.id !== 'dev');
            agentId = other ? other.id : body.data[0]?.id;
        }
    });

    it('should return 400 for invalid agent', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: {
                model: 'invalid-agent-id',
                messages: [{ role: 'user', content: 'hi' }]
            }
        });
        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.payload);
        expect(body.error.code).toBe('model_not_found');
    }, 30000);

    it('should handle chat completion (success or timeout handled)', async () => {
        if (!agentId) {
            console.warn('Skipping chat test because no agentId found');
            return;
        }
        console.log(`Testing Chat Completion with Agent: ${agentId}`);

        const response = await server.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: {
                model: agentId,
                messages: [
                    { role: 'user', content: 'hi' }
                ]
            }
        });

        console.log(`Response Status: ${response.statusCode}`);

        // If agent works, we get 200. 
        // If agent hangs and we time out, we get 500 (but verified it didn't hang forever).
        // Since we know 'main' hangs in this env, we accept 500 as "Server handled the hang".
        expect([200, 500]).toContain(response.statusCode);

        const body = JSON.parse(response.payload);
        console.log('Chat Response:', JSON.stringify(body, null, 2));

        expect(response.statusCode).toBe(200);
        expect(body.choices[0].message.content).toContain('Hello from Mock!');
    }, 70000); // 70s timeout to allow server 60s timeout to trigger
});
