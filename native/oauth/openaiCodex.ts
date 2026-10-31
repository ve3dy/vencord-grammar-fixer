/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";

import { request, requestJson } from "../http";
import type { LoginContext, OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt, pkce, randomState, sleep, startCallbackServer } from "./util";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
// OpenAI only allowlists this exact redirect, so a busy port can't fall back to another one
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_MAX_POLLS = 120;

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
// Identify as omp, whose originator the client id is registered with. The backend gates models on `version`
const ORIGINATOR = "omp";
const CLIENT_VERSION = "0.159.0";
const USER_AGENT = "omp/18.14.0";

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

function tokenProfile(access: string, idToken?: string) {
    const claims = [decodeJwt(access), idToken ? decodeJwt(idToken) : {}];
    const accountId: unknown = claims.map(c => c[AUTH_CLAIM]?.chatgpt_account_id).find(Boolean);
    const email: unknown = claims.map(c => c[PROFILE_CLAIM]?.email).find(Boolean);
    const residency: unknown = claims.map(c => c[AUTH_CLAIM]?.chatgpt_data_residency ?? c[AUTH_CLAIM]?.chatgpt_compute_residency).find(Boolean);
    return {
        accountId: typeof accountId === "string" ? accountId : undefined,
        email: typeof email === "string" ? email.trim().toLowerCase() : undefined,
        // region pinned enterprise workspaces reject requests that don't declare their residency
        residency: typeof residency === "string" && residency !== "no_constraint" ? residency : undefined
    };
}

function toCredentials(data: TokenResponse, previous?: OAuthCredentials): OAuthCredentials {
    if (!data.access_token || typeof data.expires_in !== "number")
        throw new Error("OpenAI returned an incomplete token response");

    const { accountId, email } = tokenProfile(data.access_token, data.id_token);
    const resolvedAccountId = accountId ?? previous?.extra?.accountId;
    if (!resolvedAccountId && !email && !previous)
        throw new Error("Couldn't read your ChatGPT account from the token");

    return {
        access: data.access_token,
        refresh: data.refresh_token ?? previous?.refresh,
        expires: Date.now() + data.expires_in * 1000,
        label: email ?? previous?.label,
        extra: { ...previous?.extra, ...(resolvedAccountId && { accountId: resolvedAccountId }) }
    };
}

function exchangeCode(code: string, verifier: string, redirectUri: string, signal: AbortSignal) {
    return requestJson<TokenResponse>(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri
        }),
        signal
    }).then(data => toCredentials(data));
}

async function browserLogin(ctx: LoginContext) {
    const server = await startCallbackServer({ port: CALLBACK_PORT, path: CALLBACK_PATH, signal: ctx.signal });
    try {
        const { verifier, challenge } = pkce();
        const state = randomState();
        const params = new URLSearchParams({
            response_type: "code",
            client_id: CLIENT_ID,
            redirect_uri: server.redirectUri,
            scope: SCOPE,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: ORIGINATOR
        });
        ctx.openBrowser(`${AUTHORIZE_URL}?${params}`);

        const query = await server.waitForCallback();
        const error = query.get("error");
        if (error) throw new Error(`Sign in failed: ${query.get("error_description") ?? error}`);
        if (query.get("state") !== state) throw new Error("Sign in failed: state mismatch");

        return await exchangeCode(query.get("code")!, verifier, server.redirectUri, ctx.signal);
    } finally {
        server.close();
    }
}

/** Used when port 1455 is taken, for example by a running Codex CLI login */
async function deviceLogin(ctx: LoginContext) {
    const init = await requestJson<{ device_auth_id?: string; user_code?: string; interval?: string | number; }>(DEVICE_USERCODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
        signal: ctx.signal
    });
    if (!init.device_auth_id || !init.user_code) throw new Error("OpenAI returned an incomplete device code response");

    ctx.showDeviceCode(DEVICE_AUTH_URL, init.user_code);
    const intervalMs = (Number(init.interval) || 5) * 1000 + 3000;

    for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
        await sleep(intervalMs, ctx.signal);

        const res = await fetch(DEVICE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_auth_id: init.device_auth_id, user_code: init.user_code }),
            signal: ctx.signal
        });
        // still waiting for the user
        if (res.status === 403 || res.status === 404) continue;
        if (!res.ok) throw new Error(`Device sign in failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

        const data = await res.json() as { authorization_code?: string; code_verifier?: string; };
        if (!data.authorization_code || !data.code_verifier) throw new Error("OpenAI returned an incomplete device token response");
        return exchangeCode(data.authorization_code, data.code_verifier, DEVICE_REDIRECT_URI, ctx.signal);
    }

    throw new Error("Sign in timed out");
}

/** Joins the text deltas of a Responses API event stream */
async function readResponseText(res: Response) {
    let text = "";
    let buffer = "";
    const decoder = new TextDecoder();

    const handle = (data: string) => {
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data);
        switch (event.type) {
            case "response.output_text.delta":
                text += event.delta ?? "";
                break;
            case "response.failed":
            case "response.incomplete":
                throw new Error(`ChatGPT request failed: ${event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.type}`);
            case "error":
                throw new Error(`ChatGPT request failed: ${event.message ?? event.error?.message ?? event.code ?? "unknown error"}`);
        }
    };

    for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            handle(frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"));
        }
    }

    return text.trim();
}

export const openaiCodex: OAuthProvider = {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro (Codex)",
    models: [
        { id: "gpt-6-luna", name: "GPT-6 Luna" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" }
    ],
    defaultModel: "gpt-6-luna",

    async login(ctx) {
        try {
            return await browserLogin(ctx);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
            return deviceLogin(ctx);
        }
    },

    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("No refresh token, sign in again");

        const data = await requestJson<TokenResponse>(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: creds.refresh,
                client_id: CLIENT_ID
            }),
            signal
        });
        return toCredentials(data, creds);
    },

    async complete(creds, { model, system, text, signal }) {
        const accountId = creds.extra?.accountId ?? tokenProfile(creds.access).accountId;
        const { residency } = tokenProfile(creds.access);
        const sessionId = randomUUID();

        const res = await request(RESPONSES_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${creds.access}`,
                ...(accountId && { "chatgpt-account-id": accountId }),
                ...(residency && { "x-openai-internal-codex-residency": residency }),
                "x-codex-routing-hint": `model=${model}`,
                "OpenAI-Beta": "responses=experimental",
                "originator": ORIGINATOR,
                "version": CLIENT_VERSION,
                "User-Agent": USER_AGENT,
                "conversation_id": sessionId,
                "session_id": sessionId,
                "x-client-request-id": sessionId,
                "Accept": "text/event-stream",
                "Content-Type": "application/json"
            },
            // the backend only accepts streamed, unstored requests and rejects sampling params and output caps
            body: JSON.stringify({
                model,
                instructions: system,
                input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
                reasoning: { effort: "none" },
                text: { verbosity: "low" },
                store: false,
                stream: true
            }),
            signal
        });

        const reply = await readResponseText(res);
        if (!reply) throw new Error("ChatGPT returned an empty reply");
        return reply;
    }
};
