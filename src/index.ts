import { createServer } from './server';
import { loadConfig } from './config';

const start = async () => {
    const config = await loadConfig();

    const server = await createServer(config);

    try {
        await server.listen({ port: config.httpPort, host: config.httpHost });
        console.log(`ClawProxy listening on http://${config.httpHost}:${config.httpPort}`);
        if (config.apiKey) {
            console.log('Authentication enabled (API Key required)');
        }

        const shutdown = async (signal: string) => {
            console.log(`Received ${signal}. Shutting down gracefully...`);
            await server.close();
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
