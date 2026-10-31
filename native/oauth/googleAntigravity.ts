/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomUUID } from "crypto";

import { cloudCode, type GoogleClient, googleLogin, googleRefresh, streamGenerateContent, type ThinkingConfig } from "./googleOAuth";
import type { OAuthProvider } from "./types";
import { sleep } from "./util";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FREE_TIER = "free-tier";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1000;
const METADATA = { ideType: "ANTIGRAVITY" };

// The backend gates newer models on the client version, so use the latest release and fall back to a known one
const DEFAULT_VERSION = "2.26.0";
const VERSION_MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const VERSION_RETRY_MS = 10 * 60_000;
// Each OS has exactly one native Antigravity build, the user agent names that build rather than the host
const BUILDS: Partial<Record<NodeJS.Platform, { os: string; arch: string; }>> = {
    darwin: { os: "darwin", arch: "arm64" },
    linux: { os: "linux", arch: "amd64" },
    win32: { os: "windows", arch: "amd64" }
};

interface AntigravityModel {
    id: string;
    name: string;
    /** SKU sent on the wire, the lowest thinking tier of the model */
    wire: string;
    /** `labels.model_enum` and output cap the native client sends for this SKU */
    modelEnum?: string;
    maxOutputTokens: number;
    thinking?: ThinkingConfig;
    claude?: boolean;
}

const MODELS: AntigravityModel[] = [
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", wire: "gemini-3.1-flash-lite", modelEnum: "MODEL_PLACEHOLDER_M50", maxOutputTokens: 65535, thinking: { includeThoughts: false, thinkingLevel: "MINIMAL" } },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", wire: "gemini-3.5-flash-lite", modelEnum: "MODEL_PLACEHOLDER_M198", maxOutputTokens: 65535, thinking: { includeThoughts: false, thinkingLevel: "LOW" } },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", wire: "gemini-3.8-flash-low", modelEnum: "MODEL_PLACEHOLDER_M320", maxOutputTokens: 65536, thinking: { includeThoughts: false, thinkingBudget: 1000 } },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", wire: "gemini-2.5-flash", modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH", maxOutputTokens: 65535, thinking: { includeThoughts: false, thinkingBudget: 0 } },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", wire: "gemini-3.1-pro-low", modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535, thinking: { includeThoughts: false, thinkingBudget: 0 } },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", wire: "claude-sonnet-4-6", maxOutputTokens: 64000, claude: true }
];

let discoveredVersion: string | null = null;
let versionCheckedAt = 0;

async function clientVersion(signal: AbortSignal) {
    if (!discoveredVersion && Date.now() - versionCheckedAt > VERSION_RETRY_MS) {
        versionCheckedAt = Date.now();
        try {
            const res = await fetch(VERSION_MANIFEST_URL, {
                headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
            });
            const version = res.ok ? /^\s*version\s*:\s*["']?(\d+\.\d+\.\d+)["']?\s*(?:#.*)?$/m.exec(await res.text())?.[1] : undefined;
            discoveredVersion = version ?? null;
        } catch { }
    }
    return discoveredVersion ?? DEFAULT_VERSION;
}

/** Mirrors the native Go client: its user agent, gzip only and no specific Accept */
async function headers(access: string, signal: AbortSignal) {
    const { os, arch } = BUILDS[process.platform] ?? { os: "linux", arch: "amd64" };
    return {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/hub/${await clientVersion(signal)} (aidev_client; os_type=${os}; arch=${arch}; cl=1005016104)`,
        "Accept-Encoding": "gzip"
    };
}

interface LoadCodeAssistResponse {
    currentTier?: { id?: string; } | null;
    paidTier?: { id?: string; } | null;
    allowedTiers?: { id?: string; }[];
    ineligibleTiers?: { tierId?: string; reasonMessage?: string; validationUrl?: string; }[];
    cloudaicompanionProject?: string;
}

interface Operation {
    name?: string;
    done?: boolean;
    error?: { code?: number; message?: string; } | null;
    response?: object | null;
}

async function discoverProject(access: string, signal: AbortSignal) {
    const requestHeaders = await headers(access, signal);
    const post = async <T>(label: string, url: string, body: object, timeoutSignal = signal): Promise<T> =>
        (await cloudCode(label, url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal: timeoutSignal })).json();

    // Without a paid tier the project only shows up when asked for explicitly
    const loadCodeAssist = async () => {
        const data = await post<LoadCodeAssistResponse>("loadCodeAssist", `${DAILY_ENDPOINT}/v1internal:loadCodeAssist`, { metadata: METADATA });
        if (data.paidTier || !data.cloudaicompanionProject) return data;
        return post<LoadCodeAssistResponse>("loadCodeAssist", `${DAILY_ENDPOINT}/v1internal:loadCodeAssist`, {
            cloudaicompanionProject: data.cloudaicompanionProject,
            metadata: METADATA
        });
    };

    const initial = await loadCodeAssist();
    const ineligible = initial.ineligibleTiers?.find(tier => tier.tierId === FREE_TIER);
    if (!initial.allowedTiers?.some(tier => tier.id === FREE_TIER) && ineligible?.reasonMessage) {
        throw new Error(ineligible.validationUrl ? `${ineligible.reasonMessage}\n${ineligible.validationUrl}` : ineligible.reasonMessage);
    }

    if (!initial.currentTier) {
        const onboardSignal = AbortSignal.any([signal, AbortSignal.timeout(ONBOARD_TIMEOUT_MS)]);
        let operation = await post<Operation>("onboardUser", `${DAILY_ENDPOINT}/v1internal:onboardUser`, { tierId: FREE_TIER, metadata: METADATA }, onboardSignal);
        while (!operation.done) {
            if (!operation.name) throw new Error("onboardUser returned an operation without a name");
            await sleep(ONBOARD_POLL_INTERVAL_MS, onboardSignal);
            operation = await (await cloudCode("onboardUser operation", `${DAILY_ENDPOINT}/v1internal/${operation.name}`, { headers: requestHeaders, signal: onboardSignal })).json();
        }
        if (operation.error) throw new Error(`Setting up Antigravity failed: ${operation.error.message ?? JSON.stringify(operation.error)}`);
    }

    const { cloudaicompanionProject } = await loadCodeAssist();
    if (!cloudaicompanionProject) throw new Error("Google didn't return an Antigravity project for this account");
    return cloudaicompanionProject;
}

/** Signed decimal session id derived from the prompt, like the native client */
function sessionId(text: string) {
    const value = createHash("sha256").update(text).digest().readBigUInt64BE(0) & ((1n << 63n) - 1n);
    return `-${value}`;
}

// The client Google's Antigravity app signs in with. Installed apps ship their client secret, so Google
// doesn't treat it as a secret: https://developers.google.com/identity/protocols/oauth2#installed
const client: GoogleClient = {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
        "https://www.googleapis.com/auth/aicode"
    ],
    port: 51121,
    path: "/oauth-callback",
    pkce: true,
    discoverProject
};

export const googleAntigravity: OAuthProvider = {
    id: "google-antigravity",
    name: "Google Antigravity",
    models: MODELS.map(({ id, name }) => ({ id, name })),
    defaultModel: "gemini-3.1-flash-lite",

    login: ctx => googleLogin(client, ctx),
    refresh: (creds, signal) => googleRefresh(client, creds, signal),

    async complete(creds, { model, system, text, signal }) {
        const project = creds.extra?.projectId;
        if (!project) throw new Error("Sign in again to set up your Antigravity project");

        const info = MODELS.find(m => m.id === model);
        const wire = info?.wire ?? model;
        const agentId = randomUUID();
        const trajectoryId = randomUUID();
        const claude = String(info?.claude ?? false);
        // Labels in alphabetical order, as the native client sends them for the first step of a new conversation
        const labels: Record<string, string> = {
            cascade_id: agentId,
            last_step_index: "0",
            ...(info?.modelEnum && { model_enum: info.modelEnum }),
            request_id: `${trajectoryId}-0`,
            root_cascade_id: agentId,
            trajectory_id: trajectoryId,
            used_claude: claude,
            used_claude_conservative: claude,
            used_non_gemini_model: String(!wire.startsWith("gemini"))
        };

        return streamGenerateContent([DAILY_ENDPOINT, SANDBOX_ENDPOINT], await headers(creds.access, signal), {
            project,
            requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/1`,
            request: {
                contents: [{ role: "user", parts: [{ text }] }],
                systemInstruction: { role: "user", parts: [{ text: system }] },
                labels,
                ...(info && { generationConfig: { maxOutputTokens: info.maxOutputTokens, ...(info.thinking && { thinkingConfig: info.thinking }) } }),
                sessionId: sessionId(text)
            },
            model: wire,
            userAgent: "antigravity"
        }, signal);
    }
};
