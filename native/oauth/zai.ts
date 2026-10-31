/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "crypto";

import { openAiChat, requestJson } from "../http";
import type { OAuthProvider } from "./types";
import { parsePastedCode } from "./util";

const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
// Z.ai only accepts ZCode's desktop scheme as redirect, so the user pastes the redirected URL back
const REDIRECT_URI = "zcode://zai-auth/callback";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = "https://api.z.ai";
// Our own key so signing in never touches the keys of ZCode or omp
const KEY_NAME = "grammar-fixer";
const CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
// GLM-5.3 models always think and reject turning it off
const ALWAYS_THINKING = /^glm-5\.3/;

interface ZaiProject { projectId?: string; isDefault?: boolean; }
interface ZaiOrganization { organizationId?: string; isDefault?: boolean; projects?: ZaiProject[]; }

/** Z.ai wraps responses in `{ code, msg, data, success }`; the OAuth endpoint uses code 0, the business APIs 200 */
function unwrap(body: Record<string, any> | undefined, operation: string): Record<string, any> | undefined {
    if (!body || typeof body !== "object" || !("code" in body || "success" in body)) return body;
    const code = String(body.code ?? 0);
    if (body.success === false || (code !== "0" && code !== "200"))
        throw new Error(`Z.ai ${operation} failed: ${body.msg ?? `code ${code}`}`);
    return "data" in body ? body.data : body;
}

const trimmed = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Turns the short-lived OAuth token into a durable `apiKey.secretKey` API key, like ZCode:
 * business login, default org/project, find or create our key, then copy its full secret.
 */
async function mintApiKey(oauthToken: string, signal: AbortSignal) {
    const login = unwrap(await requestJson(`${BIZ_BASE}/api/auth/z/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: oauthToken }),
        signal
    }), "business login");
    const bizToken = trimmed(login?.access_token) ?? trimmed(login?.accessToken);
    if (!bizToken) throw new Error("Z.ai business login returned no token");

    const headers = { Authorization: `Bearer ${bizToken}` };
    const customer = unwrap(await requestJson(`${BIZ_BASE}/api/biz/customer/getCustomerInfo`, { headers, signal }), "customer lookup");
    const orgs: ZaiOrganization[] = Array.isArray(customer?.organizations) ? customer.organizations : [];
    const org = orgs.find(o => o?.isDefault) ?? orgs[0];
    const projects = Array.isArray(org?.projects) ? org.projects : [];
    const project = projects.find(p => p?.isDefault) ?? projects[0];
    const orgId = trimmed(org?.organizationId);
    const projectId = trimmed(project?.projectId);
    if (!orgId || !projectId) throw new Error("Your Z.ai account has no organization or project");

    const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
    const list = unwrap(await requestJson(keysUrl, { headers, signal }), "API key list");
    const keys: { name?: string; apiKey?: string; }[] = Array.isArray(list) ? list : [list?.list, list?.keys, list?.apiKeys, list?.records].find(Array.isArray) ?? [];
    const key = keys.find(k => k?.name === KEY_NAME) ?? unwrap(await requestJson(keysUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: KEY_NAME }),
        signal
    }), "API key creation");
    const apiKey = trimmed(key?.apiKey);
    if (!apiKey) throw new Error("Z.ai didn't return an API key");

    // the list masks secrets, only the copy endpoint always returns the full one
    const copied = unwrap(await requestJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, { headers, signal }), "API key copy");
    const secret = trimmed(copied?.secretKey);
    if (!secret) throw new Error("Z.ai didn't return the API key secret");
    return `${apiKey}.${secret}`;
}

export const zai: OAuthProvider = {
    id: "zai",
    name: "Z.ai GLM Coding Plan",
    models: [
        { id: "glm-4.5-air", name: "GLM-4.5-Air" },
        { id: "glm-4.7", name: "GLM-4.7" },
        { id: "glm-5", name: "GLM-5" },
        { id: "glm-5-turbo", name: "GLM-5-Turbo" },
        { id: "glm-5.1", name: "GLM-5.1" },
        { id: "glm-5.2", name: "GLM-5.2" },
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash" }
    ],
    defaultModel: "glm-4.5-air",

    async login(ctx) {
        const state = randomBytes(16).toString("hex");
        const params = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, state });
        const pasted = await ctx.prompt(
            "Sign in to Z.ai. Your browser then tries to open a zcode:// link: copy that link (or the code in it) and paste it here.",
            `${AUTHORIZE_URL}?${params}`
        );

        const { code, state: pastedState } = parsePastedCode(pasted);
        if (!code) throw new Error("No authorization code found in what you pasted");
        if (pastedState && pastedState !== state) throw new Error("The pasted link is from a different sign in, try again");

        const token = unwrap(await requestJson(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "zai", code, redirect_uri: REDIRECT_URI, state: pastedState ?? state }),
            signal: ctx.signal
        }), "token exchange");
        const oauthToken = trimmed(token?.zai?.access_token);
        if (!oauthToken) throw new Error("Z.ai didn't return an access token");

        const accountId = token?.user?.id;
        return {
            access: await mintApiKey(oauthToken, ctx.signal),
            label: trimmed(token?.user?.email),
            extra: accountId != null ? { accountId: String(accountId) } : undefined
        };
    },

    complete(creds, { model, system, text, signal }) {
        return openAiChat({
            url: CHAT_URL,
            headers: { Authorization: `Bearer ${creds.access}` },
            model,
            system,
            text,
            body: ALWAYS_THINKING.test(model) ? undefined : { thinking: { type: "disabled" } },
            signal
        });
    }
};
