/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { HttpError, openAiChat, request, requestJson } from "../http";
import type { OAuthProvider } from "./types";
import { sleep } from "./util";

const DEVICE_AUTH_URL = "https://api.kilo.ai/api/device-auth/codes";
const CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
const POLL_INTERVAL_MS = 5000;
// Kilo tokens don't expire on their own; omp treats them as valid for a year
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;
// Lowest reasoning effort each model accepts, omp's way of turning thinking down on the gateway
const LOWEST_EFFORT: Record<string, string> = {
    "google/gemini-3.1-flash-lite": "minimal",
    "google/gemini-3.5-flash-lite": "minimal",
    "anthropic/claude-haiku-5.5": "minimal",
    "openai/gpt-5.4-nano": "low",
    "openai/gpt-5.6-luna": "low",
    "deepseek/deepseek-v4-flash": "low",
    "x-ai/grok-4.1-fast": "minimal",
    "kilo-auto/small": "minimal"
};

export const kilo: OAuthProvider = {
    id: "kilo",
    name: "Kilo Gateway",
    models: [
        { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
        { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
        { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
        { id: "openai/gpt-5.4-nano", name: "GPT-5.4 Nano" },
        { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { id: "x-ai/grok-4.1-fast", name: "Grok 4.1 Fast" },
        { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2 24B" },
        { id: "kilo-auto/small", name: "Kilo Auto Small" }
    ],
    defaultModel: "google/gemini-3.1-flash-lite",

    async login(ctx) {
        let device: { code?: string; verificationUrl?: string; expiresIn?: number; };
        try {
            device = await requestJson(DEVICE_AUTH_URL, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctx.signal });
        } catch (e) {
            if (e instanceof HttpError && e.status === 429) throw new Error("Too many pending Kilo sign ins, try again later");
            throw e;
        }

        const { code, verificationUrl, expiresIn } = device;
        if (!code || !verificationUrl || typeof expiresIn !== "number" || expiresIn <= 0)
            throw new Error("Kilo's device authorization response is missing the code");
        ctx.showDeviceCode(verificationUrl, code);

        const deadline = Date.now() + expiresIn * 1000;
        while (Date.now() < deadline) {
            let res: Response;
            try {
                res = await request(`${DEVICE_AUTH_URL}/${encodeURIComponent(code)}`, { signal: ctx.signal });
            } catch (e) {
                if (e instanceof HttpError && e.status === 403) throw new Error("Kilo sign in was denied");
                if (e instanceof HttpError && e.status === 410) throw new Error("The Kilo code expired, sign in again");
                throw e;
            }

            if (res.status !== 202) {
                const { status, token } = await res.json();
                if (status === "approved" && token) return { access: token, expires: Date.now() + TOKEN_LIFETIME_MS };
                if (status === "denied") throw new Error("Kilo sign in was denied");
                if (status === "expired") throw new Error("The Kilo code expired, sign in again");
            }
            await sleep(POLL_INTERVAL_MS, ctx.signal);
        }

        throw new Error("Kilo sign in timed out");
    },

    complete(creds, { model, system, text, signal }) {
        const effort = LOWEST_EFFORT[model];
        return openAiChat({
            url: CHAT_URL,
            headers: { Authorization: `Bearer ${creds.access}` },
            model,
            system,
            text,
            body: effort ? { reasoning_effort: effort } : undefined,
            signal
        });
    }
};
