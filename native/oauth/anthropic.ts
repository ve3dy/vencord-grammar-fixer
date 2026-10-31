/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomBytes, randomUUID } from "crypto";

import { HttpError, request, requestJson } from "../http";
import type { CompletionRequest, LoginContext, OAuthCredentials, OAuthProvider } from "./types";
import { parsePastedCode, pkce, startCallbackServer } from "./util";

// Mirrors oh-my-pi's Claude Code fingerprint (claude-code-fingerprint.ts, anthropic-headers.ts)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const EXPIRY_SKEW_MS = 5 * 60_000;

const SDK_VERSION = "0.112.1";
const OAUTH_BETA = "oauth-2025-04-20";
const UTILITY_BETAS = [
    OAUTH_BETA,
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "structured-outputs-2025-12-15"
];
const EFFORT_BETA = "effort-2025-11-24";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER = "cch=00000";
const MAX_TOKENS = 4096;

// Raised at runtime when the API rejects the pinned version as too old
let claudeCodeVersion = "2.1.280";
const sessionId = randomUUID();
const fallbackDeviceId = randomBytes(32).toString("hex");

const STAINLESS_OS: Record<string, string> = { darwin: "MacOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" };
const STAINLESS_ARCH: Record<string, string> = { x64: "x64", arm64: "arm64", ia32: "x86" };

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { uuid?: string; email_address?: string; };
    organization?: { uuid?: string; };
}

function toCredentials(data: TokenResponse, previous?: OAuthCredentials): OAuthCredentials {
    const extra = { ...previous?.extra };
    if (data.account?.uuid) extra.accountId = data.account.uuid;
    if (!previous && data.organization?.uuid) extra.orgId = data.organization.uuid;
    extra.deviceId ??= randomBytes(32).toString("hex");

    return {
        access: data.access_token,
        refresh: data.refresh_token ?? previous?.refresh,
        expires: data.expires_in ? Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS : undefined,
        label: data.account?.email_address ?? previous?.label,
        extra
    };
}

/** Fills the email/account id from Claude Code's bootstrap endpoint when the token response lacks them */
async function withIdentity(creds: OAuthCredentials, signal: AbortSignal) {
    if (creds.label && creds.extra?.accountId) return creds;
    try {
        const data = await requestJson(BOOTSTRAP_URL, {
            headers: {
                Accept: "application/json, text/plain, */*",
                Authorization: `Bearer ${creds.access}`,
                "Content-Type": "application/json",
                "User-Agent": `claude-code/${claudeCodeVersion}`,
                "anthropic-beta": OAUTH_BETA
            },
            signal
        });
        const account = data?.oauth_account;
        return {
            ...creds,
            label: creds.label ?? (account?.account_email || undefined),
            extra: { ...creds.extra, accountId: creds.extra?.accountId ?? account?.account_uuid ?? "" }
        };
    } catch {
        return creds;
    }
}

async function login(ctx: LoginContext): Promise<OAuthCredentials> {
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString("hex");
    const server = await startCallbackServer({ port: CALLBACK_PORT, path: CALLBACK_PATH, signal: ctx.signal });

    try {
        const url = `${AUTHORIZE_URL}?${new URLSearchParams({
            client_id: CLIENT_ID,
            response_type: "code",
            redirect_uri: server.redirectUri,
            scope: SCOPES,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            code: "true"
        })}`;

        ctx.openBrowser(url);
        // the browser may not reach localhost, so also accept the pasted redirect URL or code
        const pasted = ctx.prompt("If the browser didn't return to Discord, paste the final URL or the authorization code").then(parsePastedCode);
        const result = await Promise.race([
            server.waitForCallback().then(params => {
                const error = params.get("error");
                if (error) throw new Error(`Sign in failed: ${params.get("error_description") ?? error}`);
                // unlike a pasted code, a redirect always carries the state, so a missing one is a forged callback
                if (params.get("state") !== state) throw new Error("Sign in failed: state mismatch, please try again");
                return { code: params.get("code") ?? "", state };
            }),
            pasted
        ]);

        if (!result.code) throw new Error("No authorization code received");
        if (result.state && result.state !== state) throw new Error("Sign in failed: state mismatch, please try again");

        const data = await requestJson<TokenResponse>(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                client_id: CLIENT_ID,
                code: result.code,
                redirect_uri: server.redirectUri,
                code_verifier: verifier,
                state: result.state ?? state
            }),
            signal: ctx.signal
        });
        return await withIdentity(toCredentials(data), ctx.signal);
    } finally {
        server.close();
    }
}

async function refresh(creds: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
    if (!creds.refresh) throw new Error("Claude session expired, please sign in again");

    const data = await requestJson<TokenResponse>(TOKEN_URL, {
        method: "POST",
        headers: {
            "anthropic-beta": OAUTH_BETA,
            "User-Agent": `anthropic-sdk-typescript/${SDK_VERSION} userOAuthProvider`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }),
        signal
    });
    return withIdentity(toCredentials(data, creds), signal);
}

/** How to turn thinking off: older models take `disabled`, adaptive-only ones need the lowest effort instead */
function thinkingOff(model: string): Record<string, unknown> {
    const match = /^claude-(\w+)-(\d+)(?:-(\d))?/.exec(model);
    const family = match?.[1] ?? "";
    const version = match ? Number(match[2]) + Number(match[3] ?? 0) / 10 : 0;

    if (family === "sonnet" && version >= 5.5) return { thinking: { type: "between_tools" } };
    const adaptiveOnly = family === "fable" || family === "mythos"
        || ((family === "opus" || family === "sonnet") && version >= 4.6)
        || (family === "haiku" && version >= 5.5);
    return adaptiveOnly ? { output_config: { effort: "low" } } : { thinking: { type: "disabled" } };
}

function billingHeader(firstUserText: string) {
    const seed = [4, 7, 20].map(i => firstUserText[i] ?? "0").join("");
    const suffix = createHash("sha256").update(`59cf53e54c78${seed}${claudeCodeVersion}`).digest("hex").slice(0, 3);
    return `${BILLING_PREFIX} cc_version=${claudeCodeVersion}.${suffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

const MASK = (1n << 64n) - 1n;
const P1 = 0x9E3779B185EBCA87n;
const P2 = 0xC2B2AE3D27D4EB4Fn;
const P3 = 0x165667B19E3779F9n;
const P4 = 0x85EBCA77C2B2AE63n;
const P5 = 0x27D4EB2F165667C5n;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & MASK;
const xxRound = (acc: bigint, input: bigint) => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;

function xxHash64(data: Buffer, seed: bigint) {
    const len = data.length;
    let offset = 0;
    let h: bigint;

    if (len >= 32) {
        const v = [(seed + P1 + P2) & MASK, (seed + P2) & MASK, seed, (seed - P1) & MASK];
        for (; offset <= len - 32; offset += 32)
            for (let i = 0; i < 4; i++) v[i] = xxRound(v[i], data.readBigUInt64LE(offset + i * 8));
        h = (rotl(v[0], 1n) + rotl(v[1], 7n) + rotl(v[2], 12n) + rotl(v[3], 18n)) & MASK;
        for (const value of v) h = (((h ^ xxRound(0n, value)) * P1) + P4) & MASK;
    } else {
        h = (seed + P5) & MASK;
    }

    h = (h + BigInt(len)) & MASK;
    for (; offset + 8 <= len; offset += 8)
        h = ((rotl(h ^ xxRound(0n, data.readBigUInt64LE(offset)), 27n) * P1) + P4) & MASK;
    if (offset + 4 <= len) {
        h = ((rotl(h ^ ((BigInt(data.readUInt32LE(offset)) * P1) & MASK), 23n) * P2) + P3) & MASK;
        offset += 4;
    }
    for (; offset < len; offset++)
        h = (rotl(h ^ ((BigInt(data[offset]) * P5) & MASK), 11n) * P1) & MASK;

    h = ((h ^ (h >> 33n)) * P2) & MASK;
    h = ((h ^ (h >> 29n)) * P3) & MASK;
    return h ^ (h >> 32n);
}

/** Replaces the billing header's `cch=00000` with Claude Code's body attestation hash */
function attest(json: string) {
    const body = Buffer.from(json);
    // messages serialize before system, so anchor on system[0] to skip user text
    const index = body.indexOf(CCH_PLACEHOLDER, body.indexOf(`"system":[{"type":"text","text":"${BILLING_PREFIX}`));
    const cch = (xxHash64(body, 0x4d659218e32a3268n) & 0xfffffn).toString(16).padStart(5, "0");
    body.write(cch, index + 4, "latin1");
    return body;
}

async function send(creds: OAuthCredentials, { model, system, text, signal }: CompletionRequest) {
    const thinking = thinkingOff(model);
    const betas = "output_config" in thinking ? [...UTILITY_BETAS, EFFORT_BETA] : UTILITY_BETAS;
    const extra = creds.extra ?? {};
    const userId: Record<string, string> = { device_id: extra.deviceId ?? fallbackDeviceId, session_id: sessionId };
    if (extra.accountId) userId.account_uuid = extra.accountId;

    // field order matches Claude Code's; the cch hash covers the exact bytes
    const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
        system: [
            { type: "text", text: billingHeader(text) },
            { type: "text", text: IDENTITY, cache_control: { type: "ephemeral" } },
            { type: "text", text: system }
        ],
        tools: [],
        metadata: { user_id: JSON.stringify(userId) },
        max_tokens: MAX_TOKENS,
        ...thinking,
        stream: false
    });

    const res = await request(MESSAGES_URL, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
            "X-Claude-Code-Session-Id": sessionId,
            "X-Stainless-Arch": STAINLESS_ARCH[process.arch] ?? `other::${process.arch}`,
            "X-Stainless-Lang": "js",
            "X-Stainless-OS": STAINLESS_OS[process.platform] ?? `Other::${process.platform}`,
            "X-Stainless-Package-Version": SDK_VERSION,
            "X-Stainless-Retry-Count": "0",
            "X-Stainless-Runtime": "node",
            "X-Stainless-Runtime-Version": "v26.3.0",
            "X-Stainless-Timeout": "600",
            "anthropic-beta": betas.join(","),
            "anthropic-dangerous-direct-browser-access": "true",
            "anthropic-version": "2023-06-01",
            Authorization: `Bearer ${creds.access}`,
            "x-app": "cli",
            Connection: "keep-alive"
        },
        body: attest(body),
        signal
    });

    const data = await res.json();
    const content: string = (data?.content ?? [])
        .filter((part: { type: string; }) => part.type === "text")
        .map((part: { text: string; }) => part.text)
        .join("");
    if (!content) throw new Error(`Claude returned no text (stop reason: ${data?.stop_reason ?? "unknown"})`);
    return content;
}

export const anthropic: OAuthProvider = {
    id: "anthropic",
    name: "Claude Pro/Max",
    models: [
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8" }
    ],
    defaultModel: "claude-haiku-5-5",
    login,
    refresh,
    async complete(creds, req) {
        try {
            return await send(creds, req);
        } catch (error) {
            // the pinned Claude Code version went stale: adopt the one the API asks for and retry once
            const required = error instanceof HttpError && error.message.includes("claude_code_version_too_old")
                ? /version (\d+\.\d+\.\d+) or newer is required/i.exec(error.message)?.[1]
                : undefined;
            if (!required || required === claudeCodeVersion) throw error;
            claudeCodeVersion = required;
            return send(creds, req);
        }
    }
};
