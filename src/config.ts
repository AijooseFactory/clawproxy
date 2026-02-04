import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

export interface ClawProxyConfig {
    gatewayUrl: string;
    gatewayToken?: string;
    httpPort: number;
    httpHost: string;
    apiKey?: string;
    defaultModel: string;
    verbose: boolean;
    sessionMode: 'passthrough' | 'stateful';
}

const DEFAULT_CONFIG: ClawProxyConfig = {
    gatewayUrl: 'ws://127.0.0.1:19001',
    httpPort: 8080,
    httpHost: '127.0.0.1',
    defaultModel: 'dev',
    verbose: false,
    sessionMode: 'passthrough'
};

export async function loadConfig(): Promise<ClawProxyConfig> {
    // 1. Parse CLI args first to check for config file override
    const argv = yargs(hideBin(process.argv))
        .option('config', { type: 'string', description: 'Path to config file' })
        .option('port', { type: 'number', description: 'HTTP port' })
        .option('host', { type: 'string', description: 'HTTP host' })
        .option('gateway-url', { type: 'string', description: 'Gateway WebSocket URL' })
        .option('gateway-token', { type: 'string', description: 'Gateway Auth Token' })
        .option('api-key', { type: 'string', description: 'Optional Client API Key' })
        .option('model', { type: 'string', description: 'Default model/agent ID' })
        .option('verbose', { type: 'boolean', description: 'Verbose logging' })
        .option('session-mode', { type: 'string', choices: ['passthrough', 'stateful'], description: 'Session handling mode' })
        .help()
        .argv as any; // Type assertion simplification

    // 2. Determine config file path
    let configFilePath = argv.config;
    if (!configFilePath) {
        const localConfig = path.join(process.cwd(), 'config.json');
        const userConfig = path.join(os.homedir(), '.clawproxy', 'config.json');

        if (await fs.pathExists(localConfig)) {
            configFilePath = localConfig;
        } else if (await fs.pathExists(userConfig)) {
            configFilePath = userConfig;
        }
    }

    // 3. Load File Config
    let fileConfig: Partial<ClawProxyConfig> = {};
    if (configFilePath && await fs.pathExists(configFilePath)) {
        try {
            fileConfig = await fs.readJson(configFilePath);
        } catch (err) {
            console.error(`Failed to read config file at ${configFilePath}:`, err);
        }
    }

    // 4. Merge: Defaults < File < Env < CLI
    // We explicitly map Env vars to config keys
    const envConfig: Partial<ClawProxyConfig> = {
        gatewayUrl: process.env.CLAWPROXY_GATEWAY_URL,
        gatewayToken: process.env.CLAWPROXY_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN,
        httpPort: process.env.CLAWPROXY_PORT ? Number(process.env.CLAWPROXY_PORT) : undefined,
        httpHost: process.env.CLAWPROXY_HOST,
        apiKey: process.env.CLAWPROXY_API_KEY,
        defaultModel: process.env.CLAWPROXY_DEFAULT_MODEL,
        verbose: process.env.CLAWPROXY_VERBOSE === 'true',
        sessionMode: process.env.CLAWPROXY_SESSION_MODE as 'passthrough' | 'stateful'
    };

    // Remove undefined env values
    Object.keys(envConfig).forEach(key => (envConfig as any)[key] === undefined && delete (envConfig as any)[key]);

    const cliConfig: Partial<ClawProxyConfig> = {
        gatewayUrl: argv['gateway-url'],
        gatewayToken: argv['gateway-token'],
        httpPort: argv.port,
        httpHost: argv.host,
        apiKey: argv['api-key'],
        defaultModel: argv.model,
        verbose: argv.verbose,
        sessionMode: argv['session-mode']
    };

    // Remove undefined cli values
    Object.keys(cliConfig).forEach(key => (cliConfig as any)[key] === undefined && delete (cliConfig as any)[key]);

    return {
        ...DEFAULT_CONFIG,
        ...fileConfig,
        ...envConfig,
        ...cliConfig
    };
}
