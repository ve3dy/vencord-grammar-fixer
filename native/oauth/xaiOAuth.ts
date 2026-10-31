/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { request, requestJson } from "../http";
import { deviceCodeLogin } from "./deviceCodeFlow";
import type { OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt } from "./util";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER = "https://auth.x.ai";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const RESPONSES_URL = "https://api.x.ai/v1/responses";
const EXPIRY_SKEW_MS = 5 * 60_000;
// Only these accept `reasoning.effort` ("low" is their lowest); the others reject it or don't reason
const EFFORT_MODELS: Record<string, true> = { "grok-4.3": true, "grok-4.5": true, "grok-4.6": true, "grok-4.7": true };

/** The token endpoint comes from OIDC discovery; it receives refresh tokens, so it's pinned to xAI's auth origin */
async function tokenEndpoint(signal: AbortSignal) {
    const { token_endpoint: url } = await requestJson(`${ISSUER}/.well-known/openid-configuration`, { headers: { Accept: "application/json" }, signal });
    const host = URL.canParse(url) ? new URL(url) : undefined;
    if (host?.protocol !== "https:" || !(host.hostname === "x.ai" || host.hostname.endsWith(".x.ai")))
        throw new Error(`xAI returned an invalid token endpoint: ${url}`);
    return url as string;
}

async function toCredentials(data: Record<string, any>, signal: AbortSignal, previous?: OAuthCredentials): Promise<OAuthCredentials> {
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number")
        throw new Error("xAI didn't return an access token");

    let label = previous?.label;
    let accountId = decodeJwt(data.access_token).sub ?? previous?.extra?.accountId;
    // userinfo only adds the email shown in settings, so failures are ignored like omp does
    try {
        const info = await (await request(`${ISSUER}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${data.access_token}` }, signal })).json();
        if (typeof info.email === "string") label = info.email;
        if (typeof info.sub === "string") accountId = info.sub;
    } catch {
        if (signal.aborted) throw new Error("Sign in cancelled");
    }

    return {
        access: data.access_token,
        refresh: data.refresh_token ?? previous?.refresh,
        expires: Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
        label,
        extra: accountId ? { accountId: String(accountId) } : undefined
    };
}

export const xaiOAuth: OAuthProvider = {
    id: "xai-oauth",
    name: "xAI Grok (SuperGrok / X Premium+)",
    models: [
        { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 (Non-Reasoning)" },
        { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast" },
        { id: "grok-4.3", name: "Grok 4.3" },
        { id: "grok-4.5", name: "Grok 4.5" },
        { id: "grok-4.6", name: "Grok 4.6" },
        { id: "grok-4.7", name: "Grok 4.7" },
        { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 (Reasoning)" },
        { id: "grok-build", name: "Grok Build" }
    ],
    defaultModel: "grok-4.20-0309-non-reasoning",

    async login(ctx) {
        const data = await deviceCodeLogin(ctx, {
            deviceUrl: `${ISSUER}/oauth2/device/code`,
            tokenUrl: await tokenEndpoint(ctx.signal),
            clientId: CLIENT_ID,
            scope: SCOPE
        });
        return toCredentials(data, ctx.signal);
    },

    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("xAI session expired, sign in again");
        const data = await requestJson(await tokenEndpoint(signal), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }).toString(),
            signal
        });
        return toCredentials(data, signal, creds);
    },

    async complete(creds, { model, system, text, signal }) {
        const data = await requestJson(RESPONSES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.access}` },
            body: JSON.stringify({
                model,
                instructions: system,
                input: [{ role: "user", content: [{ type: "input_text", text }] }],
                store: false,
                ...(EFFORT_MODELS[model] ? { reasoning: { effort: "low" } } : {})
            }),
            signal
        });

        const content = typeof data?.output_text === "string" && data.output_text
            ? data.output_text
            : (data?.output ?? [])
                .filter((item: { type: string; }) => item.type === "message")
                .flatMap((item: { content?: { type: string; text?: string; }[]; }) => item.content ?? [])
                .filter((part: { type: string; }) => part.type === "output_text")
                .map((part: { text?: string; }) => part.text ?? "")
                .join("");
        if (content) return content;
        throw new Error("api.x.ai didn't return any text");
    }
};
