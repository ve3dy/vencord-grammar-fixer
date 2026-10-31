/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { arch, hostname, platform, release, version } from "os";

import { anthropicMessages, requestJson } from "../http";
import { deviceCodeLogin } from "./deviceCodeFlow";
import type { OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt } from "./util";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const AUTH_BASE = "https://auth.kimi.com";
const TOKEN_URL = `${AUTH_BASE}/api/oauth/token`;
const MESSAGES_URL = "https://api.kimi.com/coding/v1/messages";
// omp identifies as the Kimi CLI with its own version
const CLIENT_VERSION = "18.14.1";
const EXPIRY_SKEW_MS = 5 * 60_000;
// K2.7 Code Highspeed has no effort ladder, every other model takes the lowest adaptive effort to turn thinking down
const NO_EFFORT_MODEL = "kimi-for-coding-highspeed";

const sanitize = (value: string) => value.replace(/[^\x20-\x7E]/g, "").trim() || "unknown";

function deviceModel() {
    const os = platform();
    const label = os === "darwin" ? "macOS" : os === "win32" ? "Windows" : os === "linux" ? "Linux" : os;
    return [label, release(), arch()].filter(Boolean).join(" ");
}

/** Kimi rejects requests without its CLI fingerprint; the device id has to stay the same for a sign in */
function kimiHeaders(deviceId: string) {
    return {
        "User-Agent": `KimiCLI/${CLIENT_VERSION}`,
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": CLIENT_VERSION,
        "X-Msh-Device-Name": sanitize(hostname()),
        "X-Msh-Device-Model": sanitize(deviceModel()),
        "X-Msh-Os-Version": sanitize(version()),
        "X-Msh-Device-Id": sanitize(deviceId)
    };
}

function toCredentials(data: Record<string, any>, deviceId: string, previous?: OAuthCredentials): OAuthCredentials {
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number")
        throw new Error("Kimi didn't return an access token");

    const claims = decodeJwt(data.access_token);
    const accountId = claims.user_id ?? claims.sub ?? previous?.extra?.accountId;
    return {
        access: data.access_token,
        refresh: data.refresh_token ?? previous?.refresh,
        expires: Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
        label: previous?.label,
        extra: { deviceId, ...(accountId ? { accountId: String(accountId) } : {}) }
    };
}

export const kimiCode: OAuthProvider = {
    id: "kimi-code",
    name: "Kimi Code",
    models: [
        { id: "kimi-for-coding", name: "K2.8 Preview" },
        { id: "kimi-for-coding-highspeed", name: "K2.7 Code Highspeed" },
        { id: "k3", name: "K3" },
        { id: "k3-256k", name: "K3-256k" },
        { id: "k3.1-pro", name: "K3.1 Pro" },
        { id: "k3.1-pro-highspeed", name: "K3.1 Pro Highspeed" }
    ],
    defaultModel: "kimi-for-coding",

    async login(ctx) {
        const deviceId = randomUUID().replace(/-/g, "");
        const data = await deviceCodeLogin(ctx, {
            deviceUrl: `${AUTH_BASE}/api/oauth/device_authorization`,
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID,
            headers: kimiHeaders(deviceId)
        });
        return toCredentials(data, deviceId);
    },

    async refresh(creds, signal) {
        if (!creds.refresh) throw new Error("Kimi session expired, sign in again");
        const deviceId = creds.extra?.deviceId ?? randomUUID().replace(/-/g, "");
        const data = await requestJson(TOKEN_URL, {
            method: "POST",
            headers: { ...kimiHeaders(deviceId), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }).toString(),
            signal
        });
        return toCredentials(data, deviceId, creds);
    },

    complete(creds, { model, system, text, signal }) {
        return anthropicMessages({
            url: MESSAGES_URL,
            headers: { ...kimiHeaders(creds.extra?.deviceId ?? "unknown"), Authorization: `Bearer ${creds.access}` },
            model,
            system,
            text,
            body: model === NO_EFFORT_MODEL ? { thinking: { type: "disabled" } } : { output_config: { effort: "low" } },
            signal
        });
    }
};
