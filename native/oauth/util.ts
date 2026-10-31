/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomBytes } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export const base64Url = (data: Buffer) => data.toString("base64url");

export function randomState() {
    return base64Url(randomBytes(16));
}

export function pkce() {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

export function decodeJwt(token: string): Record<string, any> {
    try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    } catch {
        return {};
    }
}

export function sleep(ms: number, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(new Error("Sign in cancelled"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Sign in cancelled"));
    }, { once: true });
    return promise;
}

export interface CallbackServer {
    /** The redirect URI to register with the provider, like http://localhost:1455/auth/callback */
    redirectUri: string;
    /** Resolves with the query of the first request to the callback path that has `code` or `error` */
    waitForCallback(): Promise<URLSearchParams>;
    close(): void;
}

const PAGE = (message: string) => `<!doctype html><meta charset="utf-8"><title>GrammarFixer</title>
<body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>${message}</p></body>`;

/**
 * Listens on localhost for an OAuth redirect. Pass port 0 for a random port.
 * Some providers only accept the exact port their client was registered with.
 */
export async function startCallbackServer({ port, path, signal, hostname = "localhost" }: { port: number; path: string; signal: AbortSignal; hostname?: string; }): Promise<CallbackServer> {
    const { promise: callback, resolve: resolveCallback, reject: rejectCallback } = Promise.withResolvers<URLSearchParams>();

    const handler = (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== path || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
            res.writeHead(404).end();
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(PAGE(url.searchParams.has("error") ? "Sign in failed. You can close this tab and try again in Discord." : "Signed in. You can close this tab and go back to Discord."));
        resolveCallback(url.searchParams);
    };

    // browsers may resolve localhost to either IPv4 or IPv6, so listen on both
    const servers: Server[] = [];
    const listen = (host: string, listenPort: number) => {
        const { promise, resolve, reject } = Promise.withResolvers<number>();
        const server = createServer(handler);
        server.once("error", reject);
        server.listen(listenPort, host, () => {
            servers.push(server);
            resolve((server.address() as AddressInfo).port);
        });
        return promise;
    };

    const boundPort = await listen("127.0.0.1", port);
    await listen("::1", boundPort).catch(() => { });

    const close = () => servers.forEach(server => server.close());
    const timeout = setTimeout(() => rejectCallback(new Error("Sign in timed out")), CALLBACK_TIMEOUT_MS);
    signal.addEventListener("abort", () => rejectCallback(new Error("Sign in cancelled")), { once: true });
    callback.finally(() => {
        clearTimeout(timeout);
        close();
    }).catch(() => { });

    return {
        redirectUri: `http://${hostname}:${boundPort}${path}`,
        waitForCallback: () => callback,
        close
    };
}

/** Parses a pasted authorization code, accepting either the bare code, `code#state` or the whole redirected URL */
export function parsePastedCode(input: string) {
    const value = input.trim();
    if (URL.canParse(value)) {
        const url = new URL(value);
        return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? undefined };
    }

    const [code, state] = value.split("#");
    return { code, state };
}
