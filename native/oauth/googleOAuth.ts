/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "crypto";

import { requestJson } from "../http";
import type { LoginContext, OAuthCredentials } from "./types";
import { pkce, startCallbackServer } from "./util";

// Shared by Gemini CLI and Antigravity: both are Google OAuth clients for Cloud Code Assist

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const EXPIRY_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface GoogleClient {
    clientId: string;
    clientSecret: string;
    scopes: string[];
    /** Loopback port and path the client is registered with */
    port: number;
    path: string;
    pkce: boolean;
    /** Finds or provisions the Cloud Code Assist project the account sends requests to */
    discoverProject(access: string, signal: AbortSignal): Promise<string>;
}

export interface ThinkingConfig {
    includeThoughts: boolean;
    thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
    thinkingBudget?: number;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

/** Error from a Cloud Code Assist endpoint that keeps the raw body, some flows inspect it */
export class CloudCodeError extends Error {
    constructor(message: string, readonly status: number, readonly body: string) {
        super(message);
    }
}

function errorMessage(body: string) {
    const validationUrl = extractValidationUrl(body);
    if (validationUrl) return `Google requires account verification. Visit ${validationUrl}, then try again`;

    try {
        let data = JSON.parse(body);
        if (Array.isArray(data)) data = data[0];
        if (typeof data?.error?.message === "string") return data.error.message;
    } catch { }

    return body.slice(0, 300);
}

function extractValidationUrl(body: string): string | undefined {
    if (!body.includes("VALIDATION_REQUIRED")) return;
    try {
        const data = JSON.parse(body.slice(body.indexOf("{")));
        const details: { reason?: string; metadata?: { validation_url?: string; }; }[] = data?.error?.details ?? [];
        return details.find(d => d.reason === "VALIDATION_REQUIRED" && typeof d.metadata?.validation_url === "string")?.metadata?.validation_url;
    } catch {
        return;
    }
}

/** fetch against Cloud Code Assist that throws {@link CloudCodeError} on non-2xx responses */
export async function cloudCode(label: string, url: string, init: RequestInit & { signal: AbortSignal; }) {
    const res = await fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    if (!res.ok) {
        const body = await res.text();
        throw new CloudCodeError(`${label} failed (${res.status}): ${errorMessage(body) || res.statusText}`, res.status, body);
    }
    return res;
}

function expiresAt(token: TokenResponse) {
    if (typeof token.expires_in !== "number") throw new Error("Google token response is missing expires_in");
    return Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS;
}

function postToken(params: Record<string, string>, signal: AbortSignal) {
    return requestJson<TokenResponse>(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal
    });
}

export function buildAuthorizeUrl(client: GoogleClient, redirectUri: string, state: string, challenge?: string) {
    const params = new URLSearchParams({
        client_id: client.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: client.scopes.join(" ")
    });
    if (challenge) {
        params.set("code_challenge", challenge);
        params.set("code_challenge_method", "S256");
    }
    params.set("state", state);
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    return `${AUTHORIZE_URL}?${params}`;
}

export async function googleLogin(client: GoogleClient, ctx: LoginContext): Promise<OAuthCredentials> {
    const { signal } = ctx;
    const server = await startCallbackServer({ port: client.port, path: client.path, signal, hostname: "127.0.0.1" });
    const state = randomBytes(16).toString("hex");
    const verifier = client.pkce ? pkce() : undefined;

    let params: URLSearchParams;
    try {
        ctx.openBrowser(buildAuthorizeUrl(client, server.redirectUri, state, verifier?.challenge));
        params = await server.waitForCallback();
    } finally {
        server.close();
    }

    const error = params.get("error");
    if (error) throw new Error(`Google sign in failed: ${params.get("error_description") ?? error}`);
    if (params.get("state") !== state) throw new Error("Google sign in failed: state mismatch");

    const tokenParams: Record<string, string> = {
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: params.get("code") ?? "",
        redirect_uri: server.redirectUri
    };
    if (verifier) tokenParams.code_verifier = verifier.verifier;
    const token = await postToken(tokenParams, signal);
    if (!token.refresh_token) throw new Error("Google didn't return a refresh token. Please try again");

    const email = await requestJson<{ email?: string; }>(USERINFO_URL, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal
    }).then(info => info.email, () => undefined);

    const projectId = await client.discoverProject(token.access_token, signal);
    return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: expiresAt(token),
        label: email,
        extra: { projectId }
    };
}

export async function googleRefresh(client: GoogleClient, creds: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
    if (!creds.refresh || !creds.extra?.projectId) throw new Error("Session is incomplete, please sign in again");

    const token = await postToken({
        grant_type: "refresh_token",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: creds.refresh
    }, signal);
    return {
        ...creds,
        access: token.access_token,
        refresh: token.refresh_token ?? creds.refresh,
        expires: expiresAt(token)
    };
}

/** Sends `body` to streamGenerateContent, trying the next endpoint on transient failures, and returns the reply text */
export async function streamGenerateContent(endpoints: string[], headers: Record<string, string>, body: object, signal: AbortSignal) {
    const json = JSON.stringify(body);
    for (const [i, endpoint] of endpoints.entries()) {
        try {
            const res = await cloudCode("Cloud Code Assist", `${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
                method: "POST",
                headers,
                body: json,
                signal
            });
            return parseSseText(await res.text());
        } catch (e) {
            const last = i === endpoints.length - 1;
            const transient = !(e instanceof CloudCodeError) || e.status === 408 || e.status === 429 || e.status >= 500;
            if (last || signal.aborted || !transient) throw e;
        }
    }
    throw new Error("No Cloud Code Assist endpoint configured");
}

interface ResponseChunk {
    response?: {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean; }[]; }; finishReason?: string; }[];
        promptFeedback?: { blockReason?: string; };
    };
}

/** Joins the visible text of every SSE event; thought parts are skipped */
export function parseSseText(body: string) {
    let text = "";
    let finishReason: string | undefined;
    let blockReason: string | undefined;

    for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n");
        if (!data) continue;

        let chunk: ResponseChunk;
        try {
            chunk = JSON.parse(data);
        } catch {
            continue;
        }

        blockReason ??= chunk.response?.promptFeedback?.blockReason;
        const candidate = chunk.response?.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        for (const part of candidate?.content?.parts ?? []) {
            if (part.text && !part.thought) text += part.text;
        }
    }

    if (!text) {
        const reason = blockReason ?? finishReason;
        throw new Error(`Cloud Code Assist returned no text${reason ? ` (${reason})` : ""}`);
    }
    return text;
}
