/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cloudCode, CloudCodeError, type GoogleClient, googleLogin, googleRefresh, streamGenerateContent, type ThinkingConfig } from "./googleOAuth";
import type { OAuthProvider } from "./types";
import { sleep } from "./util";

const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CLI_VERSION = "0.46.0";
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const PROJECT_HELP = "This account needs the GOOGLE_CLOUD_PROJECT environment variable set to a Google Cloud project, see https://goo.gle/gemini-cli-auth-docs#workspace-gca";

const METADATA = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

// Lowest thinking each model accepts; Cloud Code Assist applies the model's own default when thinkingConfig is omitted
const MODELS: { id: string; name: string; thinking: ThinkingConfig; }[] = [
    { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", thinking: { includeThoughts: false, thinkingLevel: "MINIMAL" } },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", thinking: { includeThoughts: false, thinkingLevel: "MINIMAL" } },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", thinking: { includeThoughts: false, thinkingBudget: 0 } },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", thinking: { includeThoughts: false, thinkingLevel: "LOW" } },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", thinking: { includeThoughts: false, thinkingBudget: 128 } }
];

/** Identifies as the official Gemini CLI, which gets higher rate limits */
function cliHeaders(model = "gemini-3.1-pro-preview") {
    return {
        "User-Agent": `GeminiCLI/${CLI_VERSION}/${model} (${process.platform}; ${process.arch}; terminal)`,
        "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"
    };
}

interface LoadCodeAssistResponse {
    cloudaicompanionProject?: string;
    currentTier?: { id?: string; };
    allowedTiers?: { id?: string; isDefault?: boolean; }[];
}

interface Operation {
    name?: string;
    done?: boolean;
    response?: { cloudaicompanionProject?: { id?: string; }; };
}

async function discoverProject(access: string, signal: AbortSignal) {
    const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    const headers = { Authorization: `Bearer ${access}`, "Content-Type": "application/json", ...cliHeaders() };

    let data: LoadCodeAssistResponse;
    try {
        const res = await cloudCode("loadCodeAssist", `${ENDPOINT}/v1internal:loadCodeAssist`, {
            method: "POST",
            headers,
            body: JSON.stringify({ cloudaicompanionProject: envProject, metadata: { ...METADATA, duetProject: envProject } }),
            signal
        });
        data = await res.json();
    } catch (e) {
        // VPC Service Controls block loadCodeAssist for some Workspace accounts that are already on the standard tier
        if (!(e instanceof CloudCodeError) || !e.body.includes("SECURITY_POLICY_VIOLATED")) throw e;
        data = { currentTier: { id: "standard-tier" } };
    }

    if (data.currentTier) {
        const project = data.cloudaicompanionProject || envProject;
        if (!project) throw new Error(PROJECT_HELP);
        return project;
    }

    const tierId = data.allowedTiers?.find(tier => tier.isDefault)?.id ?? TIER_LEGACY;
    if (tierId !== TIER_FREE && !envProject) throw new Error(PROJECT_HELP);

    const onboard = tierId === TIER_FREE
        ? { tierId, metadata: METADATA }
        : { tierId, metadata: { ...METADATA, duetProject: envProject }, cloudaicompanionProject: envProject };
    let operation: Operation = await cloudCode("onboardUser", `${ENDPOINT}/v1internal:onboardUser`, {
        method: "POST",
        headers,
        body: JSON.stringify(onboard),
        signal
    }).then(res => res.json());

    for (let attempt = 0; !operation.done && operation.name; attempt++) {
        if (attempt === POLL_MAX_ATTEMPTS) throw new Error("Setting up your Gemini project took too long, please try again");
        await sleep(POLL_INTERVAL_MS, signal);
        operation = await cloudCode("Project setup", `${ENDPOINT}/v1internal/${operation.name}`, { headers, signal }).then(res => res.json());
    }

    const project = operation.response?.cloudaicompanionProject?.id || envProject;
    if (!project) throw new Error(`Couldn't set up a Google Cloud project. ${PROJECT_HELP}`);
    return project;
}

// Gemini CLI's public client, as published in its source. Installed apps ship their client secret, so Google
// doesn't treat it as a secret: https://developers.google.com/identity/protocols/oauth2#installed
const client: GoogleClient = {
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
    ],
    port: 8085,
    path: "/oauth2callback",
    pkce: false,
    discoverProject
};

export const googleGeminiCli: OAuthProvider = {
    id: "google-gemini-cli",
    name: "Gemini CLI (Google account)",
    models: MODELS.map(({ id, name }) => ({ id, name })),
    defaultModel: "gemini-3.1-flash-lite-preview",

    login: ctx => googleLogin(client, ctx),
    refresh: (creds, signal) => googleRefresh(client, creds, signal),

    async complete(creds, { model, system, text, signal }) {
        const project = creds.extra?.projectId;
        if (!project) throw new Error("Sign in again to set up your Gemini project");

        const thinkingConfig = MODELS.find(m => m.id === model)?.thinking;
        return streamGenerateContent([ENDPOINT], {
            Authorization: `Bearer ${creds.access}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...cliHeaders(model)
        }, {
            project,
            model,
            request: {
                contents: [{ role: "user", parts: [{ text }] }],
                systemInstruction: { parts: [{ text: system }] },
                ...(thinkingConfig && { generationConfig: { thinkingConfig } })
            }
        }, signal);
    }
};
