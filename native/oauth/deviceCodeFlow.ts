/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { requestJson } from "../http";
import type { LoginContext } from "./types";
import { sleep } from "./util";

const REQUEST_TIMEOUT_MS = 15_000;

export interface DeviceCodeOptions {
    deviceUrl: string;
    tokenUrl: string;
    clientId: string;
    scope?: string;
    headers?: Record<string, string>;
}

/** RFC 8628 device authorization: shows the user code, then polls until the token endpoint grants it. Returns the token response. */
export async function deviceCodeLogin(ctx: LoginContext, { deviceUrl, tokenUrl, clientId, scope, headers }: DeviceCodeOptions): Promise<Record<string, any>> {
    const form = (params: Record<string, string>): RequestInit => ({
        method: "POST",
        headers: { Accept: "application/json", ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });

    const device = await requestJson(deviceUrl, form(scope ? { client_id: clientId, scope } : { client_id: clientId }));

    const { user_code: userCode, device_code: deviceCode, verification_uri: uri, verification_uri_complete: uriComplete } = device ?? {};
    if (typeof userCode !== "string" || typeof deviceCode !== "string" || typeof uri !== "string")
        throw new Error("Device authorization response is missing the user code");

    ctx.showDeviceCode(typeof uriComplete === "string" ? uriComplete : uri, userCode);

    const deadline = Date.now() + (typeof device.expires_in === "number" ? device.expires_in : 15 * 60) * 1000;
    let intervalMs = Math.max(1000, (typeof device.interval === "number" ? device.interval : 5) * 1000);

    while (Date.now() < deadline) {
        await sleep(intervalMs, ctx.signal);

        // polls answer 400 while pending, so they go through plain fetch instead of `request`
        const res = await fetch(tokenUrl, form({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: deviceCode
        }));
        const text = await res.text();
        let body: Record<string, any> = {};
        try {
            body = JSON.parse(text);
        } catch { }

        if (res.ok && body.error === undefined) return body;
        switch (body.error) {
            case "authorization_pending":
                continue;
            case "slow_down":
                intervalMs += 5000;
                continue;
            case "expired_token":
                throw new Error("The device code expired, sign in again");
            case "access_denied":
                throw new Error("Sign in was denied");
            default:
                throw new Error(`Sign in failed (${res.status}): ${body.error_description ?? body.error ?? text.slice(0, 300)}`);
        }
    }

    throw new Error("Sign in timed out");
}
