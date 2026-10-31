/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";

import { anthropicMessages, requestJson } from "../http";
import { deviceCodeLogin } from "./deviceCodeFlow";
import type { OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt } from "./util";

// WorkOS public client of the Factory CLI; its access token authorizes Factory's LLM proxy
const CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
const TOKEN_URL = "https://api.workos.com/user_management/authenticate";
const CLIENT_VERSION = "0.237.0";
const RUNTIME_VERSION = "v26.3.0";
// The proxy only serves requests whose system prompt starts with the Droid identity
const DROID_IDENTITY = "You are Droid, an AI software engineering agent built by Factory.";

const apiBase = (region: string | undefined) => region === "eu" ? "https://api.eu.factory.ai" : "https://api.factory.ai";

/** Wire, upstream router and the request fields that turn reasoning off, per model (omp's factory-droid catalog) */
const MODELS: Record<string, { name: string; wire: "anthropic" | "completions"; upstream: string; body: object; }> = {
    "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", wire: "anthropic", upstream: "anthropic", body: {} },
    "claude-haiku-5-5": { name: "Claude Haiku 5.5", wire: "anthropic", upstream: "anthropic", body: { thinking: { type: "disabled" } } },
    "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", wire: "anthropic", upstream: "anthropic", body: { thinking: { type: "disabled" } } },
    "glm-5.3-flash": { name: "GLM-5.3-Flash", wire: "completions", upstream: "fireworks", body: { reasoning_effort: "none" } },
    "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", wire: "completions", upstream: "fireworks", body: { reasoning_effort: "none" } },
    "kimi-k3": { name: "Kimi K3", wire: "completions", upstream: "fireworks", body: { reasoning_effort: "none" } }
};

const stainlessOs = { darwin: "MacOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" }[process.platform as string] ?? `Other::${process.platform}`;
const stainlessArch = { x64: "x64", arm64: "arm64", ia32: "x86" }[process.arch as string] ?? `other::${process.arch}`;

function credentialsFrom(token: Record<string, any>, previous?: OAuthCredentials): OAuthCredentials {
    if (typeof token.access_token !== "string") throw new Error("Factory didn't return an access token");
    const claims = decodeJwt(token.access_token);
    return {
        access: token.access_token,
        refresh: token.refresh_token ?? previous?.refresh,
        expires: typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 86_400_000,
        label: token.user?.email ?? claims.email ?? previous?.label,
        extra: {
            ...previous?.extra,
            // only the token's external org claim is valid as X-Factory-Org-Id; WorkOS org ids scope refresh grants
            ...(claims.external_org_id ? { orgId: claims.external_org_id } : {}),
            ...(token.organization_id ? { workosOrgId: token.organization_id } : {})
        }
    };
}

function refreshGrant(refreshToken: string, workosOrgId: string | undefined, signal: AbortSignal) {
    return requestJson(TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
            ...(workosOrgId ? { organization_id: workosOrgId } : {})
        }).toString(),
        signal
    });
}

/** Resolves the Factory organization and residency region of the login, like omp's factory-droid-region hook */
async function whoami(creds: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
    const orgId = creds.extra?.orgId;
    const body = await requestJson(`${apiBase(creds.extra?.region)}/api/cli/whoami`, {
        headers: { Authorization: `Bearer ${creds.access}`, Accept: "application/json", ...(orgId ? { "X-Factory-Org-Id": orgId } : {}) },
        signal
    });
    const resolvedOrg = typeof body?.orgId === "string" && body.orgId ? body.orgId : orgId;
    const region = body?.region === "eu" || body?.region === "global" ? body.region : creds.extra?.region;
    return {
        ...creds,
        extra: { ...creds.extra, ...(resolvedOrg ? { orgId: resolvedOrg } : {}), ...(region ? { region } : {}) }
    };
}

export const factoryDroid: OAuthProvider = {
    id: "factory-droid",
    name: "Factory Droid",
    models: Object.entries(MODELS).map(([id, { name }]) => ({ id, name })),
    defaultModel: "claude-haiku-4-5-20251001",

    async login(ctx) {
        const token = await deviceCodeLogin(ctx, {
            deviceUrl: "https://api.workos.com/user_management/authorize/device",
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID
        });
        if (typeof token.refresh_token !== "string") throw new Error("Factory didn't return a refresh token");

        let creds = await whoami(credentialsFrom(token), ctx.signal);
        // a token without an org claim is rejected by the proxy: scope a refresh grant to the account's WorkOS organization
        if (!creds.extra?.orgId && !creds.extra?.workosOrgId) {
            const orgs = await requestJson(`${apiBase(creds.extra?.region)}/api/cli/org`, {
                headers: { Authorization: `Bearer ${creds.access}`, Accept: "application/json" },
                signal: ctx.signal
            }).catch(() => undefined);
            const workosOrgId = orgs?.workosOrgIds?.[0];
            if (typeof workosOrgId === "string" && workosOrgId) {
                const scoped = await refreshGrant(creds.refresh!, workosOrgId, ctx.signal);
                creds = await whoami(credentialsFrom(scoped, { ...creds, extra: { ...creds.extra, workosOrgId } }), ctx.signal);
            }
        }
        if (!creds.extra?.orgId) throw new Error("Factory sign in didn't resolve an organization");
        return creds;
    },

    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("Sign in to Factory again");
        return credentialsFrom(await refreshGrant(creds.refresh, creds.extra?.workosOrgId, signal), creds);
    },

    async complete(creds, { model, system, text, signal }) {
        const route = MODELS[model] ?? { wire: model.startsWith("claude-") ? "anthropic" : "completions", upstream: model.startsWith("claude-") ? "anthropic" : "fireworks", body: {} };
        const requestId = randomUUID();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${creds.access}`,
            "User-Agent": `factory-cli/${CLIENT_VERSION}`,
            "X-Client-Version": CLIENT_VERSION,
            "X-Factory-Client": "cli",
            ...(creds.extra?.orgId ? { "X-Factory-Org-Id": creds.extra.orgId } : {}),
            "x-api-provider": route.upstream,
            "x-provider-routing-source": "registry_default",
            "x-session-id": requestId,
            "x-assistant-message-id": requestId,
            "X-Stainless-Lang": "js",
            "X-Stainless-Package-Version": route.wire === "anthropic" ? "0.70.1" : "6.25.0",
            "X-Stainless-Runtime": "node",
            "X-Stainless-Runtime-Version": RUNTIME_VERSION,
            "X-Stainless-Arch": stainlessArch,
            "X-Stainless-OS": stainlessOs,
            "X-Stainless-Retry-Count": "0"
        };
        const base = apiBase(creds.extra?.region);

        if (route.wire === "anthropic") {
            return anthropicMessages({
                url: `${base}/api/llm/a/v1/messages`,
                // the CLI's Anthropic SDK pins a 600s timeout and needs an x-api-key; the bearer authenticates
                headers: { ...headers, "X-Stainless-Timeout": "600", "x-api-key": "placeholder" },
                model,
                system,
                text,
                body: {
                    system: [{ type: "text", text: DROID_IDENTITY }, ...(system ? [{ type: "text", text: system }] : [])],
                    ...route.body
                },
                signal
            });
        }

        const url = `${base}/api/llm/o/v1/chat/completions`;
        const data = await requestJson(url, {
            method: "POST",
            headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: DROID_IDENTITY },
                    ...(system ? [{ role: "system", content: system }] : []),
                    { role: "user", content: text }
                ],
                temperature: 1,
                ...route.body
            }),
            signal
        });
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content) return content;
        throw new Error("Factory didn't return any text");
    }
};
