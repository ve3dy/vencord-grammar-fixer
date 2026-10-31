/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ModelInfo } from "../../types";

export interface OAuthCredentials {
    access: string;
    refresh?: string;
    /** Epoch ms when `access` expires */
    expires?: number;
    /** Shown in settings next to "Signed in", like an email */
    label?: string;
    /** Provider specific values, like an account or project id */
    extra?: Record<string, string>;
}

export interface LoginContext {
    /** Opens the URL in the user's browser and shows it in settings in case it didn't open */
    openBrowser(url: string): void;
    /** Opens `url` and shows the device code the user has to enter there */
    showDeviceCode(url: string, code: string): void;
    /** Asks the user to paste something, like an authorization code or the redirected URL. Opens `url` first if given */
    prompt(message: string, url?: string): Promise<string>;
    signal: AbortSignal;
}

export interface CompletionRequest {
    model: string;
    system: string;
    text: string;
    signal: AbortSignal;
}

export interface OAuthProvider {
    /** Unique id, also the key the credentials are stored under */
    id: string;
    /** Shown in the provider list, like "Claude Pro/Max" */
    name: string;
    models: ModelInfo[];
    defaultModel: string;
    login(ctx: LoginContext): Promise<OAuthCredentials>;
    /** Returns new credentials. Called when `expires` is less than a minute away */
    refresh?(creds: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
    /** Sends a single request and returns the model's text reply */
    complete(creds: OAuthCredentials, req: CompletionRequest): Promise<string>;
}
