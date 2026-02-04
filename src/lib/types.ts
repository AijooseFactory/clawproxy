export const PROTOCOL_VERSION = 3;

export type RequestFrame = {
    type: "req";
    id: string;
    method: string;
    params?: unknown;
};

export type ResponseFrame = {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        message?: string;
        code?: string;
    };
};

export type EventFrame = {
    type: "event";
    event: string;
    payload?: unknown;
    seq?: number;
};

export type ConnectParams = {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: string;
        displayName?: string;
        version: string;
        platform?: string;
        mode?: string;
        instanceId?: string;
    };
    caps: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    pathEnv?: string;
    auth?: {
        token?: string;
        password?: string;
    };
    role?: string;
    scopes?: string[];
    device?: {
        id: string;
        publicKey: string;
        signature: string;
        signedAt: number;
        nonce?: string;
    };
};

export type HelloOk = {
    protocol: number;
    server: {
        id: string;
        version: string;
    };
    auth?: {
        role?: string;
        user?: string;
        deviceToken?: string;
        scopes?: string[];
    };
    policy?: {
        tickIntervalMs?: number;
    };
};
