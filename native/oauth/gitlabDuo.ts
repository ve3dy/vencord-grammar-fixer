/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { anthropicMessages, HttpError, openAiChat, requestJson } from "../http";
import type { LoginContext, OAuthCredentials, OAuthProvider } from "./types";
import { pkce, randomState, startCallbackServer } from "./util";

// oh-my-pi's "GitLab Duo Non-Agentic" OAuth app, registered for http://localhost:8080/callback
const CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const GITLAB_URL = "https://gitlab.com";
const TOKEN_URL = `${GITLAB_URL}/oauth/token`;
const ANTHROPIC_PROXY_URL = "https://cloud.gitlab.com/ai/v1/proxy/anthropic";
const OPENAI_PROXY_URL = "https://cloud.gitlab.com/ai/v1/proxy/openai/v1";
// GitLab's gateway tokens live 30 minutes; omp reuses them for 25
const DIRECT_ACCESS_TTL_MS = 25 * 60_000;
const EXPIRY_SKEW_MS = 5 * 60_000;

/** Duo's model aliases and the upstream ids the gateway proxies expect */
const UPSTREAM_MODELS: Record<string, string> = {
    "duo-chat-haiku-4-5": "claude-haiku-4-5-20251001",
    "duo-chat-sonnet-4-6": "claude-sonnet-4-6",
    "duo-chat-sonnet-4-5": "claude-sonnet-4-5-20250929",
    "duo-chat-opus-4-6": "claude-opus-4-6",
    "duo-chat-opus-4-5": "claude-opus-4-5-20251101",
    "duo-chat-gpt-5-mini": "gpt-5-mini-2025-08-07",
    "duo-chat-gpt-5-1": "gpt-5.1-2025-11-13",
    "duo-chat-gpt-5-2": "gpt-5.2-2025-12-11"
};

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    created_at?: number;
}

function toCredentials(data: TokenResponse, previous?: OAuthCredentials): OAuthCredentials {
    if (typeof data?.access_token !== "string") throw new Error("GitLab didn't return an access token");
    const issuedAt = typeof data.created_at === "number" ? data.created_at * 1000 : Date.now();
    return {
        access: data.access_token,
        refresh: data.refresh_token ?? previous?.refresh,
        expires: typeof data.expires_in === "number" ? issuedAt + data.expires_in * 1000 - EXPIRY_SKEW_MS : undefined,
        label: previous?.label,
        extra: previous?.extra
    };
}

async function login(ctx: LoginContext): Promise<OAuthCredentials> {
    const { verifier, challenge } = pkce();
    const state = randomState();
    const server = await startCallbackServer({ port: 8080, path: "/callback", signal: ctx.signal });

    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            response_type: "code",
            redirect_uri: server.redirectUri,
            scope: "api",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state
        });
        ctx.openBrowser(`${GITLAB_URL}/oauth/authorize?${params}`);

        const callback = await server.waitForCallback();
        const error = callback.get("error");
        if (error) throw new Error(`GitLab sign in failed: ${callback.get("error_description") ?? error}`);
        if (callback.get("state") !== state) throw new Error("GitLab sign in failed: state mismatch");

        const credentials = toCredentials(await requestJson(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code: callback.get("code") ?? "",
                redirect_uri: server.redirectUri,
                code_verifier: verifier
            }),
            signal: ctx.signal
        }));

        const user = await requestJson(`${GITLAB_URL}/api/v4/user`, {
            headers: { Authorization: `Bearer ${credentials.access}` },
            signal: ctx.signal
        }).catch(() => undefined);
        credentials.label = user?.email || user?.username;
        return credentials;
    } finally {
        server.close();
    }
}

const directAccessCache = new Map<string, { token: string; headers: Record<string, string>; expiresAt: number; }>();

/** Exchanges the GitLab token for a short lived AI gateway token plus the headers the gateway requires */
async function getDirectAccess(access: string, signal: AbortSignal) {
    const cached = directAccessCache.get(access);
    if (cached && cached.expiresAt > Date.now()) return cached;

    let data: { token?: unknown; headers?: unknown; };
    try {
        data = await requestJson(`${GITLAB_URL}/api/v4/ai/third_party_agents/direct_access`, {
            method: "POST",
            headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
            body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
            signal
        });
    } catch (err) {
        if (err instanceof HttpError && err.status === 403)
            throw new Error(`GitLab Duo access denied, make sure Duo is enabled for your account. ${err.message}`);
        throw err;
    }
    if (typeof data?.token !== "string" || !data.headers || typeof data.headers !== "object")
        throw new Error("GitLab Duo returned an invalid direct access response");

    // tokens are per GitLab access token, which rotates on refresh, so old entries are useless
    directAccessCache.clear();
    const entry = { token: data.token, headers: data.headers as Record<string, string>, expiresAt: Date.now() + DIRECT_ACCESS_TTL_MS };
    directAccessCache.set(access, entry);
    return entry;
}

export const gitlabDuo: OAuthProvider = {
    id: "gitlab-duo",
    name: "GitLab Duo",
    models: [
        { id: "duo-chat-haiku-4-5", name: "Duo Chat Haiku 4.5" },
        { id: "duo-chat-sonnet-4-6", name: "Duo Chat Sonnet 4.6" },
        { id: "duo-chat-sonnet-4-5", name: "Duo Chat Sonnet 4.5" },
        { id: "duo-chat-opus-4-6", name: "Duo Chat Opus 4.6" },
        { id: "duo-chat-opus-4-5", name: "Duo Chat Opus 4.5" },
        { id: "duo-chat-gpt-5-mini", name: "Duo Chat GPT-5 Mini" },
        { id: "duo-chat-gpt-5-1", name: "Duo Chat GPT-5.1" },
        { id: "duo-chat-gpt-5-2", name: "Duo Chat GPT-5.2" }
    ],
    defaultModel: "duo-chat-haiku-4-5",
    login,
    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("GitLab session expired, sign in again");
        return toCredentials(await requestJson(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }),
            signal
        }), creds);
    },
    async complete(creds, { model, system, text, signal }) {
        const upstream = UPSTREAM_MODELS[model];
        if (!upstream) throw new Error(`Unsupported GitLab Duo model: ${model}`);

        const direct = await getDirectAccess(creds.access, signal);
        const headers = { ...direct.headers, Authorization: `Bearer ${direct.token}` };

        if (model.startsWith("duo-chat-gpt-")) {
            return openAiChat({
                url: `${OPENAI_PROXY_URL}/chat/completions`,
                headers,
                model: upstream,
                system,
                text,
                // lowest effort GPT-5 <5.2 accepts; 5.2 dropped "minimal"
                body: { reasoning_effort: model === "duo-chat-gpt-5-2" ? "low" : "minimal" },
                signal
            });
        }

        return anthropicMessages({ url: `${ANTHROPIC_PROXY_URL}/v1/messages`, headers, model: upstream, system, text, signal });
    }
};
