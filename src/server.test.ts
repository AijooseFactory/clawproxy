// Mock GatewayClient must be before any imports that use it
jest.mock('./lib/client', () => {
    return {
        GatewayClient: jest.fn().mockImplementation(() => {
            return {
                on: jest.fn(),
                start: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                stop: jest.fn(),
                request: jest.fn<() => Promise<any>>().mockResolvedValue({ agents: [] }),
                isConnected: true
            };
        })
    };
});

import { createServer } from './server';
import { ClawProxyConfig } from './config';
import { describe, it, expect, jest } from '@jest/globals';
import { FastifyInstance } from 'fastify';

describe('Server', () => {
    const config: ClawProxyConfig = {
        gatewayUrl: 'ws://localhost:19001',
        httpPort: 0,
        httpHost: '127.0.0.1',
        defaultModel: 'dev',
        verbose: false,
        sessionMode: 'passthrough'
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
