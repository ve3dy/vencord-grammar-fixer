/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

import type { CompleteRequest, CredentialStatus, GrammarMatch, LoginState, NativeResult, ProviderInfo } from "../types";
import { type CatalogModel, type CatalogProvider, getCatalog } from "./catalog";
import { anthropicMessages, HttpError, openAiChat } from "./http";
import { checkWithLanguageTool } from "./languageTool";
import { endLoginSession, getLoginSession, startLoginSession } from "./login";
import { oauthProviders } from "./oauth";
import type { OAuthCredentials, OAuthProvider } from "./oauth/types";
import { type Credential, deleteCredential, getCredential, setCredential } from "./secrets";

// Every export of this file is callable from Discord's renderer, keep helpers out of it

const REFRESH_MARGIN_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 90_000;

async function result<T>(fn: () => Promise<T> | T): Promise<NativeResult<T>> {
    try {
        return { ok: true, value: await fn() };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

const oauthId = (provider: OAuthProvider) => `oauth:${provider.id}`;
const findOAuthProvider = (providerId: string) => oauthProviders.find(provider => oauthId(provider) === providerId);

export function getProviders(_: IpcMainInvokeEvent) {
    return result(async () => {
        const oauth = oauthProviders.map<ProviderInfo>(provider => ({
            id: oauthId(provider),
            name: `${provider.name} (sign in)`,
            auth: "oauth",
            models: provider.models,
            defaultModel: provider.defaultModel
        }));

        const catalog = (await getCatalog()).map<ProviderInfo>(({ id, name, url, models, defaultModel }) => ({
            id,
            name,
            auth: "apiKey",
            models: models.map(({ id, name }) => ({ id, name })),
            defaultModel,
            // models.dev uses placeholders like ${ACCOUNT_ID} for account specific URLs
            ...(url.includes("${") && { needsBaseUrl: true, baseUrlHint: url })
        }));

        return [
            { id: "languagetool", name: "LanguageTool (free, no key)", auth: "none", models: [] },
            ...oauth,
            { id: "custom", name: "Custom (OpenAI-compatible)", auth: "apiKey", models: [], needsBaseUrl: true, baseUrlHint: "http://localhost:11434/v1" },
            ...catalog
        ] satisfies ProviderInfo[];
    });
}

export function getCredentialStatus(_: IpcMainInvokeEvent, providerId: string): CredentialStatus {
    const credential = getCredential(providerId);
    return { signedIn: !!credential, label: credential?.type === "oauth" ? credential.creds.label : undefined };
}

export async function setApiKey(_: IpcMainInvokeEvent, providerId: string, key: string, baseUrl?: string) {
    // the URL is saved with the key so code in the page can't send the key to another server later
    const needsBaseUrl = providerId === "custom" || (await getCatalog()).find(p => p.id === providerId)?.url.includes("${");
    setCredential(providerId, { type: "apiKey", key: key.trim(), baseUrl: needsBaseUrl ? normalizeUrl(baseUrl) : undefined });
}

export function signOut(_: IpcMainInvokeEvent, providerId: string) {
    deleteCredential(providerId);
}

export function startLogin(_: IpcMainInvokeEvent, providerId: string): NativeResult<string> {
    const provider = findOAuthProvider(providerId);
    if (!provider) return { ok: false, error: "Unknown provider" };

    return { ok: true, value: startLoginSession(provider, creds => setCredential(providerId, { type: "oauth", creds })) };
}

export function getLoginState(_: IpcMainInvokeEvent, sessionId: string): LoginState {
    return getLoginSession(sessionId)?.state ?? { status: "error", error: "Sign in expired, try again" };
}

export function submitLoginInput(_: IpcMainInvokeEvent, sessionId: string, value: string) {
    getLoginSession(sessionId)?.submitInput?.(value);
}

export function cancelLogin(_: IpcMainInvokeEvent, sessionId: string) {
    endLoginSession(sessionId);
}

export function checkGrammar(_: IpcMainInvokeEvent, text: string, picky: boolean): Promise<NativeResult<GrammarMatch[]>> {
    return result(() => checkWithLanguageTool(text, picky));
}

// Rotating refresh tokens may only be used once, a second refresh with the same token can revoke the whole login
const refreshing = new Map<string, Promise<OAuthCredentials>>();

function refreshOnce(providerId: string, refresh: () => Promise<OAuthCredentials>) {
    let pending = refreshing.get(providerId);
    if (!pending) {
        pending = refresh()
            .then(fresh => {
                setCredential(providerId, { type: "oauth", creds: fresh });
                return fresh;
            })
            .finally(() => refreshing.delete(providerId));
        refreshing.set(providerId, pending);
    }
    return pending;
}

async function completeWithOAuth(providerId: string, provider: OAuthProvider, req: CompleteRequest, signal: AbortSignal) {
    const credential = getCredential(providerId);
    if (credential?.type !== "oauth") throw new Error(`Sign in to ${provider.name} in the GrammarFixer settings first.`);

    let { creds } = credential;
    if (creds.expires && creds.expires - REFRESH_MARGIN_MS < Date.now()) {
        const { refresh } = provider;
        if (!refresh) throw new Error(`Your ${provider.name} session expired, sign in again.`);
        creds = await refreshOnce(providerId, () => refresh.call(provider, creds, signal));
    }

    return provider.complete(creds, { model: req.model, system: req.system, text: req.text, signal });
}

// Thinking only slows down grammar fixes, so ask for the least the model allows
function speedParams(provider: CatalogProvider, model?: CatalogModel) {
    if (model?.thinkingToggle)
        return /qwen|alibaba|dashscope|siliconflow|modelscope|bailian/.test(provider.id)
            ? { enable_thinking: false }
            : { thinking: { type: "disabled" } };
    if (model?.effort) return { reasoning_effort: model.effort };
    return undefined;
}

function normalizeUrl(url: string | undefined) {
    return url?.trim().replace(/\/+$/, "") || undefined;
}

/** The URL the user entered for custom or account specific providers, only if it's the one the key was saved for */
function enteredBaseUrl(req: CompleteRequest, credential: Credential | undefined) {
    const url = normalizeUrl(req.baseUrl);
    if (!url || url.includes("${")) throw new Error("Set the API URL in the GrammarFixer settings first.");
    if (credential?.type === "apiKey" && credential.key && credential.baseUrl !== url)
        throw new Error("The API URL changed. Save your API key again to use it with the new URL.");
    return url;
}

async function completeWithApiKey(req: CompleteRequest, signal: AbortSignal) {
    const credential = getCredential(req.providerId);
    const key = credential?.type === "apiKey" ? credential.key : "";

    if (req.providerId === "custom") {
        return openAiChat({
            url: `${enteredBaseUrl(req, credential)}/chat/completions`,
            headers: key ? { Authorization: `Bearer ${key}` } : undefined,
            model: req.model,
            system: req.system,
            text: req.text,
            signal
        });
    }

    const provider = (await getCatalog()).find(p => p.id === req.providerId);
    if (!provider) throw new Error("This provider isn't available anymore, pick another one in the GrammarFixer settings.");

    // catalog providers always use their own URL, unless it has to be completed with account details
    const base = provider.url.includes("${") ? enteredBaseUrl(req, credential) : provider.url;
    const chat = {
        model: req.model,
        system: req.system,
        text: req.text,
        signal
    };

    if (provider.wire === "anthropic")
        return anthropicMessages({ ...chat, url: `${base}/messages`, headers: key ? { "x-api-key": key } : undefined });

    const url = `${base}/chat/completions`;
    const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
    const body = speedParams(provider, provider.models.find(m => m.id === req.model));

    try {
        return await openAiChat({ ...chat, url, headers, body });
    } catch (error) {
        // not every OpenAI-compatible server knows the thinking parameters, retry without them
        if (body && error instanceof HttpError && (error.status === 400 || error.status === 422))
            return openAiChat({ ...chat, url, headers });
        throw error;
    }
}

export function complete(_: IpcMainInvokeEvent, req: CompleteRequest): Promise<NativeResult<string>> {
    return result(() => {
        const signal = AbortSignal.timeout(COMPLETE_TIMEOUT_MS);
        const oauth = findOAuthProvider(req.providerId);
        return oauth ? completeWithOAuth(req.providerId, oauth, req, signal) : completeWithApiKey(req, signal);
    });
}
