/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ModelInfo {
    id: string;
    name: string;
}

export interface ProviderInfo {
    id: string;
    name: string;
    auth: "none" | "apiKey" | "oauth";
    models: ModelInfo[];
    defaultModel?: string;
    /** The user has to enter the API URL (custom servers, or the provider's URL contains an account id) */
    needsBaseUrl?: boolean;
    /** Shown in the API URL field */
    baseUrlHint?: string;
}

export interface CredentialStatus {
    signedIn: boolean;
    /** Account shown next to "Signed in", like an email */
    label?: string;
}

export type LoginState =
    | { status: "starting"; }
    | { status: "browser"; url: string; }
    | { status: "device"; url: string; code: string; }
    | { status: "input"; prompt: string; url?: string; }
    | { status: "done"; label?: string; }
    | { status: "error"; error: string; };

export interface CompleteRequest {
    providerId: string;
    model: string;
    baseUrl?: string;
    system: string;
    text: string;
}

export interface GrammarMatch {
    message: string;
    offset: number;
    length: number;
    replacements: { value: string; }[];
}

export type NativeResult<T> = { ok: true; value: T; } | { ok: false; error: string; };
