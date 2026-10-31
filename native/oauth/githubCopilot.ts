/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { anthropicMessages, HttpError, openAiChat, requestJson } from "../http";
import type { CompletionRequest, LoginContext, OAuthCredentials, OAuthProvider } from "./types";
import { sleep } from "./util";

// Mirrors oh-my-pi: the device flow uses the OpenCode OAuth app (minimal read:user grant),
// while API requests identify as the Copilot CLI / chat surface.
const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const OAUTH_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "copilot-developer-action/0.0.1"
};

const CLI_USER_AGENT = "copilot/1.0.82";
const CLI_INTEGRATION_ID = "copilot-developer-cli";
const CHAT_INTEGRATION_ID = "copilot-chat";
const API_HEADERS = {
    "User-Agent": CLI_USER_AGENT,
    "Editor-Version": CLI_USER_AGENT,
    "Copilot-Integration-Id": CLI_INTEGRATION_ID,
    "Copilot-Harness-Id": "copilot-sdk",
    "Openai-Intent": "conversation-agent",
    "X-GitHub-Api-Version": "2026-08-01"
};
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

type Route = "chat" | "responses" | "anthropic";

/** Same routing as omp: Claude → Anthropic Messages, GPT-5+/Grok 4.x/MAI → Responses, everything else → chat completions */
function routeOf(model: string): Route {
    if (model.startsWith("claude-")) return "anthropic";
    if (/^(gpt-5|gpt-6|grok-4\.|oswe|mai-)/.test(model)) return "responses";
    return "chat";
}

/** Lowest effort each Responses model accepts; GPT <5.2 still has "minimal" */
function minimalEffort(model: string) {
    return /^gpt-5(\.1)?(-|$)/.test(model) ? "minimal" : "low";
}

interface DeviceCode {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
}

async function pollAccessToken(device: DeviceCode, signal: AbortSignal) {
    const deadline = Date.now() + device.expires_in * 1000;
    let intervalMs = Math.max(1000, device.interval * 1000);
    // omp waits a bit longer than asked so clock drift doesn't trigger slow_down
    let multiplier = 1.2;

    while (Date.now() < deadline) {
        await sleep(Math.min(Math.ceil(intervalMs * multiplier), deadline - Date.now()), signal);

        const data = await requestJson("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: OAUTH_HEADERS,
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                device_code: device.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code"
            }),
            signal
        });

        if (typeof data?.access_token === "string") return data.access_token as string;
        if (data?.error === "authorization_pending") continue;
        if (data?.error === "slow_down") {
            intervalMs = typeof data.interval === "number" && data.interval > 0
                ? Math.max(1000, data.interval * 1000)
                : intervalMs + 5000;
            multiplier = 1.4;
            continue;
        }
        throw new Error(`GitHub sign in failed: ${data?.error_description ?? data?.error ?? "unknown response"}`);
    }

    throw new Error("GitHub sign in timed out");
}

/** Plan specific API host (individual/business/enterprise) and the account name */
async function fetchCopilotUser(token: string, signal: AbortSignal) {
    try {
        const data = await requestJson("https://api.github.com/copilot_internal/user", {
            headers: { Accept: "application/json", Authorization: `token ${token}`, "User-Agent": CLI_USER_AGENT },
            signal
        });
        const api = data?.endpoints?.api;
        return {
            apiEndpoint: typeof api === "string" && api.startsWith("https://") ? api.replace(/\/+$/, "") : undefined,
            login: typeof data?.login === "string" ? data.login as string : undefined
        };
    } catch {
        return {};
    }
}

/** Some models (Claude, Gemini, Grok) have to be enabled once per account before they can be used */
async function enableModels(token: string, base: string, signal: AbortSignal) {
    await Promise.allSettled(githubCopilot.models.map(({ id }) => requestJson(`${base}/models/${id}/policy`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...API_HEADERS,
            "Copilot-Integration-Id": CHAT_INTEGRATION_ID,
            "Openai-Intent": "chat-policy",
            "X-Initiator": "user",
            "X-Interaction-Type": "chat-policy"
        },
        body: JSON.stringify({ state: "enabled" }),
        signal
    })));
}

async function login(ctx: LoginContext): Promise<OAuthCredentials> {
    const device: DeviceCode = await requestJson("https://github.com/login/device/code", {
        method: "POST",
        headers: OAUTH_HEADERS,
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
        signal: ctx.signal
    });
    if (!device?.device_code || !device.user_code || !device.verification_uri)
        throw new Error("GitHub returned an invalid device code response");

    ctx.showDeviceCode(device.verification_uri, device.user_code);
    const token = await pollAccessToken(device, ctx.signal);

    const { apiEndpoint, login } = await fetchCopilotUser(token, ctx.signal);
    await enableModels(token, apiEndpoint ?? DEFAULT_BASE_URL, ctx.signal);

    // GitHub OAuth tokens don't expire and Copilot accepts them directly, so there is nothing to refresh
    return {
        access: token,
        label: login,
        extra: apiEndpoint ? { apiEndpoint } : undefined
    };
}

async function responses(url: string, headers: Record<string, string>, { model, system, text, signal }: CompletionRequest) {
    const data = await requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
            model,
            instructions: system,
            input: [{ role: "user", content: [{ type: "input_text", text }] }],
            reasoning: { effort: minimalEffort(model) },
            store: false,
            stream: false
        }),
        signal
    });

    const content = (data?.output ?? [])
        .filter((item: { type: string; }) => item.type === "message")
        .flatMap((item: { content?: { type: string; text?: string; }[]; }) => item.content ?? [])
        .filter((part: { type: string; }) => part.type === "output_text")
        .map((part: { text?: string; }) => part.text ?? "")
        .join("");
    if (content) return content;
    throw new Error(`${new URL(url).host} didn't return any text`);
}

function send(creds: OAuthCredentials, req: CompletionRequest, integrationId: string) {
    const base = creds.extra?.apiEndpoint ?? DEFAULT_BASE_URL;
    const headers = {
        ...API_HEADERS,
        "Copilot-Integration-Id": integrationId,
        "X-Initiator": "user",
        "X-Interaction-Type": "conversation-user",
        Authorization: `Bearer ${creds.access}`
    };
    const { model, system, text, signal } = req;

    switch (routeOf(model)) {
        case "anthropic":
            return anthropicMessages({
                url: `${base}/v1/messages`,
                headers: { ...headers, Accept: "application/json", "Anthropic-Dangerous-Direct-Browser-Access": "true" },
                model, system, text, signal
            });
        case "responses":
            return responses(`${base}/responses`, headers, req);
        case "chat":
            return openAiChat({ url: `${base}/chat/completions`, headers, model, system, text, signal });
    }
}

/** Organisations that block one client surface reject it with 403, or 400 model_not_supported */
function isIdentityDenied(err: unknown) {
    return err instanceof HttpError
        && (err.status === 403 || (err.status === 400 && /model_not_supported|not supported/i.test(err.message)));
}

export const githubCopilot: OAuthProvider = {
    id: "github-copilot",
    name: "GitHub Copilot",
    models: [
        { id: "gpt-4.1", name: "GPT-4.1" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-5-mini", name: "GPT-5 Mini" },
        { id: "gpt-5.4-nano", name: "GPT-5.4 nano" },
        { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
        { id: "gpt-5.5", name: "GPT-5.5" },
        { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
        { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
        { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
        { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
        { id: "raptor-mini", name: "Raptor mini" }
    ],
    // no reasoning and included in paid plans without premium requests
    defaultModel: "gpt-4.1",
    login,
    async complete(creds, req) {
        try {
            return await send(creds, req, CHAT_INTEGRATION_ID);
        } catch (err) {
            if (!isIdentityDenied(err)) throw err;
            // same one-shot fallback as omp: retry as the Copilot CLI
            return send(creds, req, CLI_INTEGRATION_ID);
        }
    }
};
