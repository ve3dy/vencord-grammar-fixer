/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { shell } from "electron";

import type { LoginState } from "../types";
import type { OAuthCredentials, OAuthProvider } from "./oauth/types";

const SESSION_LIFETIME_MS = 15 * 60_000;

interface Session {
    state: LoginState;
    abort: AbortController;
    expiry?: NodeJS.Timeout;
    submitInput?(value: string): void;
}

// The renderer polls these while the settings show a sign in in progress
const sessions = new Map<string, Session>();

export function startLoginSession(provider: OAuthProvider, onSignedIn: (creds: OAuthCredentials) => void) {
    const id = randomUUID();
    const session: Session = { state: { status: "starting" }, abort: new AbortController() };
    sessions.set(id, session);

    const { signal } = session.abort;
    provider.login({
        openBrowser(url) {
            shell.openExternal(url);
            session.state = { status: "browser", url };
        },
        showDeviceCode(url, code) {
            shell.openExternal(url);
            session.state = { status: "device", url, code };
        },
        prompt(prompt, url) {
            if (url) shell.openExternal(url);
            session.state = { status: "input", prompt, url };

            const { promise, resolve, reject } = Promise.withResolvers<string>();
            session.submitInput = value => {
                session.submitInput = undefined;
                session.state = { status: "starting" };
                resolve(value);
            };
            signal.addEventListener("abort", () => reject(new Error("Sign in cancelled")), { once: true });
            return promise;
        },
        signal
    }).then(creds => {
        onSignedIn(creds);
        session.state = { status: "done", label: creds.label };
    }).catch(error => {
        session.state = { status: "error", error: error instanceof Error ? error.message : String(error) };
    });

    session.expiry = setTimeout(() => endLoginSession(id), SESSION_LIFETIME_MS);

    return id;
}

export function getLoginSession(id: string) {
    return sessions.get(id);
}

export function endLoginSession(id: string) {
    const session = sessions.get(id);
    if (!session) return;

    clearTimeout(session.expiry);
    session.abort.abort();
    sessions.delete(id);
}
