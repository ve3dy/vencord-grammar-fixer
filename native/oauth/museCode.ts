/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { requestJson } from "../http";
import { deviceCodeLogin } from "./deviceCodeFlow";
import type { OAuthProvider } from "./types";

const CLIENT_ID = "1031625952748946";
const API_VERSION = "1.0.0";
const KEY_URL = "https://api.meta.ai/muse-code/key";
const RESPONSES_URL = "https://api.meta.ai/v1/responses";

// Meta's device grant has no refresh and no expiry; requests use the subscription API key minted from it
export const museCode: OAuthProvider = {
    id: "muse-code",
    name: "Muse Code (Meta)",
    models: [
        { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
        { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 (C)" },
        { id: "muse-wonder-1.0", name: "Muse Wonder" },
        { id: "muse-wonder-1.0-contributor", name: "Muse Wonder (C)" },
        { id: "muse-wonder-full-1.0", name: "Muse Wonder Full" }
    ],
    defaultModel: "muse-spark-1.3",

    async login(ctx) {
        const token = await deviceCodeLogin(ctx, {
            deviceUrl: "https://auth.meta.com/oidc/device/authorization/",
            tokenUrl: "https://auth.meta.com/oidc/device/token/",
            clientId: CLIENT_ID,
            headers: { "x-api-version": API_VERSION }
        });
        if (typeof token.access_token !== "string") throw new Error("Meta didn't return an access token");

        const key = await requestJson(KEY_URL, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token.access_token}`,
                "Content-Type": "application/json",
                "x-api-version": API_VERSION
            },
            body: JSON.stringify({ onboard: true }),
            redirect: "error",
            signal: ctx.signal
        });

        if (key?.is_subs_active === false) throw new Error("Your Muse Code subscription is inactive");
        const apiKey = typeof key?.api_key === "string" ? key.api_key.trim() : "";
        if (!apiKey) {
            const actionUrl = key?.action_url?.trim() || key?.require_payment_action_url?.trim();
            if (key?.require_payment === true || actionUrl)
                throw new Error(actionUrl ? `Muse Code needs a subscription: ${actionUrl}` : "Muse Code needs a subscription");
            throw new Error("Meta didn't return a Muse Code API key");
        }

        return { access: apiKey, label: key.user_email?.trim().toLowerCase() || undefined };
    },

    async complete(creds, { model, system, text, signal }) {
        const data = await requestJson(RESPONSES_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${creds.access}`,
                "Content-Type": "application/json",
                "x-api-version": API_VERSION
            },
            body: JSON.stringify({
                model,
                instructions: system,
                input: [{ role: "user", content: text }],
                reasoning: { effort: "minimal" },
                store: false
            }),
            signal
        });

        if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
        const output = (data?.output ?? [])
            .filter((item: { type?: string; }) => item.type === "message")
            .flatMap((item: { content?: { type?: string; text?: string; }[]; }) => item.content ?? [])
            .filter(part => part.type === "output_text")
            .map(part => part.text ?? "")
            .join("");
        if (output) return output;
        throw new Error("Muse Code didn't return any text");
    }
};
