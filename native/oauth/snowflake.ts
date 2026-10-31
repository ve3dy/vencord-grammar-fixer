/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { anthropicMessages, openAiChat, requestJson } from "../http";
import type { OAuthCredentials, OAuthProvider } from "./types";
import { parsePastedCode, pkce, randomState, startCallbackServer } from "./util";

// Snowflake's built-in SNOWFLAKE$LOCAL_APPLICATION client: public, PKCE, any loopback redirect
const CLIENT_ID = "LOCAL_APPLICATION";
const CALLBACK_PORT = 54551;

const INVALID_ACCOUNT = "Enter your Snowflake account identifier (orgname-accountname) or account URL";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const isDnsLabel = (label: string) => label.length <= 63 && DNS_LABEL.test(label);

/** Turns an account identifier, account URL or Snowsight link into https://<account>.snowflakecomputing.com, refusing any other host */
export function snowflakeAccountUrl(input: string) {
    const value = input.trim();
    if (!value) throw new Error(INVALID_ACCOUNT);

    const url = /^https:\/\/([^/?#]+)(.*)$/i.exec(value);
    if (!url && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("The Snowflake account URL must use https");
    if (!url && /[/?#]/.test(value)) throw new Error(INVALID_ACCOUNT);

    let host = (url ? url[1] : value).toLowerCase().replaceAll("_", "-").replace(/:443$/, "");
    if (url && host === "app.snowflake.com") {
        const [, org = "", account = ""] = url[2].split(/[?#]/, 1)[0].toLowerCase().replaceAll("_", "-").split("/");
        if (!isDnsLabel(org) || !isDnsLabel(account) || /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(org)) throw new Error(INVALID_ACCOUNT);
        host = `${org}-${account}.snowflakecomputing.com`;
    } else if (!url && !host.includes(".")) {
        host += ".snowflakecomputing.com";
    }

    if (host.endsWith(".snowflakecomputing.cn")) throw new Error("The Snowflake Cortex REST API isn't available in China region accounts");
    const suffix = ".snowflakecomputing.com";
    if (!host.endsWith(suffix) || host.length === suffix.length || !host.split(".").every(isDnsLabel)) throw new Error(INVALID_ACCOUNT);
    return `https://${host}`;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    username?: string;
}

async function requestToken(accountUrl: string, params: Record<string, string>, signal: AbortSignal) {
    const data = await requestJson<TokenResponse>(`${accountUrl}/oauth/token-request`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: CLIENT_ID }),
        // never follow a redirect with a code or refresh token in the body
        redirect: "error",
        signal
    });
    if (!data?.access_token || !(data.expires_in > 0)) throw new Error("Snowflake returned an invalid token response");
    return data;
}

const toCredentials = (data: TokenResponse, accountUrl: string, previous?: OAuthCredentials): OAuthCredentials => ({
    access: data.access_token,
    refresh: data.refresh_token || previous?.refresh,
    expires: Date.now() + data.expires_in * 1000,
    label: data.username || previous?.label || new URL(accountUrl).hostname.split(".")[0],
    extra: { accountUrl }
});

function accountOf(creds: OAuthCredentials) {
    const accountUrl = creds.extra?.accountUrl;
    if (!accountUrl) throw new Error("Snowflake account is missing, sign in again");
    return snowflakeAccountUrl(accountUrl);
}

export const snowflake: OAuthProvider = {
    id: "snowflake",
    name: "Snowflake Cortex",
    models: [
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "openai-gpt-5-nano", name: "GPT-5 Nano" },
        { id: "openai-gpt-5-mini", name: "GPT-5 Mini" },
        { id: "openai-gpt-5.1", name: "GPT-5.1" },
        { id: "openai-gpt-4.1", name: "GPT-4.1" }
    ],
    defaultModel: "claude-haiku-4-5",

    async login(ctx) {
        const accountUrl = snowflakeAccountUrl(await ctx.prompt("Enter your Snowflake account identifier (orgname-accountname) or account URL"));

        const { verifier, challenge } = pkce();
        const state = randomState();
        // Snowflake local-app integrations can reject callback subpaths, so redirect to the root
        const listen = (port: number) => startCallbackServer({ port, path: "/", hostname: "127.0.0.1", signal: ctx.signal });
        const server = await listen(CALLBACK_PORT).catch(() => listen(0));

        try {
            const authUrl = `${accountUrl}/oauth/authorize?${new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: "code",
                redirect_uri: server.redirectUri,
                scope: "refresh_token",
                state,
                code_challenge: challenge,
                code_challenge_method: "S256"
            })}`;

            const pasted = ctx.prompt("Sign in to Snowflake in your browser. If it doesn't return to Discord, paste the URL it ended on here", authUrl)
                .then(input => {
                    const { code, state } = parsePastedCode(input);
                    return new URLSearchParams({ code, state: state ?? "" });
                });
            const params = await Promise.race([server.waitForCallback(), pasted]);

            const error = params.get("error");
            if (error) throw new Error(`Snowflake sign in failed: ${params.get("error_description") ?? error}`);
            const code = params.get("code");
            if (!code) throw new Error("No authorization code was received");
            if (params.get("state") !== state) throw new Error("Sign in state mismatch, try again");

            const data = await requestToken(accountUrl, {
                grant_type: "authorization_code",
                code,
                redirect_uri: server.redirectUri,
                code_verifier: verifier
            }, ctx.signal);
            return toCredentials(data, accountUrl);
        } finally {
            server.close();
        }
    },

    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("Snowflake didn't issue a refresh token, sign in again");
        const accountUrl = accountOf(creds);
        const data = await requestToken(accountUrl, { grant_type: "refresh_token", refresh_token: creds.refresh }, signal);
        return toCredentials(data, accountUrl, creds);
    },

    complete(creds, { model, system, text, signal }) {
        const base = `${accountOf(creds)}/api/v2/cortex/v1`;
        const headers = { Authorization: `Bearer ${creds.access}` };

        if (model.startsWith("claude-")) return anthropicMessages({ url: `${base}/messages`, headers, model, system, text, signal });

        // Cortex rejects max_tokens and store on the chat endpoint
        return openAiChat({
            url: `${base}/chat/completions`,
            headers,
            model,
            system,
            text,
            body: {
                max_completion_tokens: 4096,
                ...(model.startsWith("openai-gpt-5") && { reasoning_effort: "minimal" })
            },
            signal
        });
    }
};
