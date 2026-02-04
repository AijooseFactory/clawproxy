import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
    loadOrCreateDeviceIdentity,
    signDevicePayload,
    buildDeviceAuthPayload,
    publicKeyRawBase64UrlFromPem,
    type DeviceIdentity
} from "./identity";
import {
    type ConnectParams,
    type EventFrame,
    type HelloOk,
    type RequestFrame,
    type ResponseFrame,
    PROTOCOL_VERSION
} from "./types";

export type GatewayClientOptions = {
    url?: string;
    requestTimeoutMs?: number;
    token?: string;
};

const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const CLIENT_ROLE = "operator";

export class GatewayClient {
    private ws: WebSocket | null = null;
    private url: string;
    private token?: string;
    private deviceIdentity: DeviceIdentity;
    private pending = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
    private connectNonce: string | null = null;

    public onEvent: ((evt: EventFrame) => void) | null = null;

    constructor(opts?: GatewayClientOptions) {
        this.url = opts?.url ?? "ws://127.0.0.1:18789";
        this.token = opts?.token;
        this.deviceIdentity = loadOrCreateDeviceIdentity();
    }

    public get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    public async start() {
        await this.connectWithRetry();
    }

    private async connectWithRetry(retries = 0): Promise<void> {
        try {
            await this.connect();
            console.log('GatewayClient: Connected successfully');
        } catch (err) {
            const delay = Math.min(1000 * Math.pow(2, retries), 30000);
            console.error(`GatewayClient: Connection failed, retrying in ${delay}ms...`, err);
            // Don't sleep if we are just starting, maybe? No, we should sleep on failure.
            // But we need to keep the process alive? fastify key logic handles errors.
            await new Promise(res => setTimeout(res, delay));
            return this.connectWithRetry(retries + 1);
        }
    }

    private connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url);

                this.ws.on('open', () => {
                    this.sendConnect().then(() => {
                        resolve();
                    }).catch(err => {
                        reject(err);
                        this.ws?.close();
                    });
                });

                this.ws.on('error', (err) => {
                    // Only reject if we are strictly connecting. 
                    // If we are established, this will be handled by 'close'
                    if (this.ws?.readyState === WebSocket.CONNECTING) {
                        reject(err);
                    } else {
                        console.error('WebSocket Error:', err);
                    }
                });

                this.ws.on('close', () => {
                    console.warn('GatewayClient: WebSocket closed. Reconnecting...');
                    this.ws = null;
                    if (this.isConnected) {
                        // Should not happen if closed
                    } else {
                        // Trigger retry loop if not explicitly stopped?
                        // For now, let's just retry
                        setTimeout(() => this.connectWithRetry(), 1000);
                    }
                });

                this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));

            } catch (err) {
                reject(err);
            }
        });
    }

    private handleMessage(data: WebSocket.Data) {
        const raw = data.toString();
        try {
            const parsed = JSON.parse(raw);
            if (parsed.type === "res") {
                const res = parsed as ResponseFrame;
                if (this.pending.has(res.id)) {
                    const p = this.pending.get(res.id)!;
                    this.pending.delete(res.id);
                    if (res.ok) {
                        p.resolve(res.payload);
                    } else {
                        p.reject(new Error(res.error?.message || "Error"));
                    }
                }
            } else if (parsed.type === "event") {
                const evt = parsed as EventFrame;
                if (evt.event === "connect.challenge") {
                    this.connectNonce = (evt.payload as any).nonce;
                    // We need to re-send connect. 
                    // Note: sendConnect returns a promise that resolves to HelloOk.
                    // We don't have anyone waiting for this promise usually when it's a challenge during re-connect?
                    this.sendConnect().catch(console.error);
                } else {
                    if (this.onEvent) this.onEvent(evt);
                }
            }
        } catch (err) {
            console.error("Message error", err);
        }
    }

    private async sendConnect(): Promise<HelloOk> {
        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayload({
            deviceId: this.deviceIdentity.deviceId,
            clientId: CLIENT_ID,
            clientMode: CLIENT_MODE,
            role: CLIENT_ROLE,
            scopes: ["operator.admin"],
            signedAtMs,
            nonce: this.connectNonce,
            token: this.token ?? null
        });

        const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);

        const device = {
            id: this.deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity.publicKeyPem),
            signature,
            signedAt: signedAtMs,
            nonce: this.connectNonce ?? undefined
        };

        const params: ConnectParams = {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
                id: CLIENT_ID,
                version: "0.1.0",
                mode: CLIENT_MODE,
                platform: process.platform
            },
            caps: [],
            role: CLIENT_ROLE,
            scopes: ["operator.admin"],
            device,
            auth: this.token ? { token: this.token } : undefined
        };

        return this.requestRaw<HelloOk>("connect", params);
    }

    public async request<T = any>(method: string, params?: any): Promise<T> {
        return this.requestRaw<T>(method, params);
    }

    private async requestRaw<T>(method: string, params?: any): Promise<T> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Not connected");
        }
        const id = randomUUID();
        const frame: RequestFrame = {
            type: "req",
            id,
            method,
            params
        };

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });

            // Debug Log
            // console.log('WS Send:', JSON.stringify(frame));

            this.ws!.send(JSON.stringify(frame));

            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error("Timeout"));
                }
            }, 10000);
        });
    }
}
