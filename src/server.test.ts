import { createServer } from './server';
import { ClawProxyConfig } from './config';
import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import { FastifyInstance } from 'fastify';

// Mock GatewayClient
jest.mock('./lib/client', () => {
    return {
        GatewayClient: jest.fn().mockImplementation(() => {
            return {
                on: jest.fn(),
                start: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                request: jest.fn<() => Promise<any>>().mockResolvedValue({ agents: [] }),
                isConnected: true
            };
        })
    };
});

describe('Server', () => {
    const config: ClawProxyConfig = {
        gatewayUrl: 'ws://localhost:19001',
        httpPort: 0,
        httpHost: '127.0.0.1',
        defaultModel: 'dev',
        verbose: false
    };

    let server: FastifyInstance;

    it('should start up and serve health check', async () => {
        server = await createServer(config);

        const response = await server.inject({
            method: 'GET',
            url: '/health'
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.status).toBe('ok');

        await server.close();
    });
});
