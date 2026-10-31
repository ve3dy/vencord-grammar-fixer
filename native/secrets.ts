/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings } from "@main/settings";
import { safeStorage } from "electron";

import type { OAuthCredentials } from "./oauth/types";

// Credentials live in the main process only. They never reach Discord's renderer,
// settings.json or Vencord's cloud sync, and are encrypted with the OS keyring when one is available.

export type Credential =
    /** `baseUrl` is set for providers whose URL the user enters, the key is only ever sent there */
    | { type: "apiKey"; key: string; baseUrl?: string; }
    | { type: "oauth"; creds: OAuthCredentials; };

function store(): Record<string, string> {
    const plugin = NativeSettings.store.plugins.GrammarFixer ??= {};
    return plugin.credentials ??= {};
}

export function getCredential(providerId: string): Credential | undefined {
    const stored = store()[providerId];
    if (!stored) return undefined;

    const [scheme, data] = stored.split(":", 2);
    const bytes = Buffer.from(data, "base64");
    return JSON.parse(scheme === "enc" ? safeStorage.decryptString(bytes) : bytes.toString());
}

export function setCredential(providerId: string, credential: Credential) {
    const json = JSON.stringify(credential);
    store()[providerId] = safeStorage.isEncryptionAvailable()
        ? `enc:${safeStorage.encryptString(json).toString("base64")}`
        : `raw:${Buffer.from(json).toString("base64")}`;
}

export function deleteCredential(providerId: string) {
    delete store()[providerId];
}
