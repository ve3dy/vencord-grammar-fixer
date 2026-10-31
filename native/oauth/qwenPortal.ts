/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openAiChat, request } from "../http";
import type { OAuthProvider } from "./types";

const CHAT_URL = "https://portal.qwen.ai/v1/chat/completions";

// Qwen ended its OAuth device sign in on 2026-04-15; like omp, the user pastes an existing Qwen OAuth token or API key
export const qwenPortal: OAuthProvider = {
    id: "qwen-portal",
    name: "Qwen Portal",
    models: [
        { id: "coder-model", name: "Qwen Coder" },
        { id: "vision-model", name: "Qwen Vision" }
    ],
    defaultModel: "coder-model",

    async login(ctx) {
        const token = (await ctx.prompt("Paste your Qwen OAuth token or API key", "https://chat.qwen.ai")).trim();
        if (!token) throw new Error("No token pasted");

        // the smallest request omp uses to check the token works
        await request(CHAT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ model: "coder-model", messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }),
            signal: ctx.signal
        });
        return { access: token };
    },

    complete(creds, { model, system, text, signal }) {
        return openAiChat({ url: CHAT_URL, headers: { Authorization: `Bearer ${creds.access}` }, model, system, text, signal });
    }
};
