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
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
