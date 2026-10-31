/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { copyWithToast } from "@utils/discord";
import { useAwaiter, useForceUpdater } from "@utils/react";
import { SearchableSelect, showToast, TextInput, useEffect, useState } from "@webpack/common";

import { settings } from ".";
import { Native, unwrap } from "./api";
import type { LoginState, ProviderInfo } from "./types";

const LOGIN_POLL_MS = 500;

const row = { display: "flex", gap: 8, alignItems: "center" } as const;

function useCredentialStatus(providerId: string) {
    const [signal, refresh] = useForceUpdater(true);
    const [status] = useAwaiter(() => Native.getCredentialStatus(providerId), { fallbackValue: null, deps: [providerId, signal] });
    return [status, refresh] as const;
}

function ApiKeySection({ provider }: { provider: ProviderInfo; }) {
    const [status, refresh] = useCredentialStatus(provider.id);
    const [key, setKey] = useState("");

    async function save() {
        await Native.setApiKey(provider.id, key, settings.store.baseUrl);
        setKey("");
        refresh();
        showToast({ text: "API key saved.", variant: "success" });
    }

    async function remove() {
        await Native.signOut(provider.id);
        refresh();
    }

    return (
        <SettingsSection
            name="API Key"
            id="apiKey"
            description={(status?.signedIn
                ? "A key is saved. Paste a new one to replace it."
                : "Paste your API key. It's stored encrypted outside Discord and never shown again. Local servers usually don't need one.")
                + (provider.needsBaseUrl ? " The key is only sent to the API URL above, save it again if you change the URL." : "")}
        >
            <div style={row}>
                <div style={{ flex: 1 }}>
                    <TextInput type="password" value={key} onChange={setKey} placeholder={status?.signedIn ? "Saved" : "API key"} />
                </div>
                <Button disabled={!key.trim()} onClick={save}>Save</Button>
                {status?.signedIn && <Button variant="dangerSecondary" onClick={remove}>Remove</Button>}
            </div>
        </SettingsSection>
    );
}

function LoginProgress({ state, onSubmit }: { state: LoginState; onSubmit(value: string): void; }) {
    const [input, setInput] = useState("");

    switch (state.status) {
        case "starting":
            return <Paragraph>Signing in...</Paragraph>;
        case "browser":
            return <Paragraph>Finish signing in in your browser. Didn't open? <Link href={state.url}>Open the sign in page</Link></Paragraph>;
        case "device":
            return (
                <div style={row}>
                    <Paragraph>Enter <b>{state.code}</b> at <Link href={state.url}>{state.url}</Link></Paragraph>
                    <Button size="small" variant="secondary" onClick={() => copyWithToast(state.code, "Code copied.")}>Copy code</Button>
                </div>
            );
        case "input":
            return (
                <>
                    <Paragraph>{state.prompt}{state.url && <> (<Link href={state.url}>open page</Link>)</>}</Paragraph>
                    <div style={{ ...row, marginTop: 8 }}>
                        <div style={{ flex: 1 }}>
                            <TextInput value={input} onChange={setInput} />
                        </div>
                        <Button disabled={!input.trim()} onClick={() => onSubmit(input.trim())}>Submit</Button>
                    </div>
                </>
            );
        case "error":
            return <Paragraph style={{ color: "var(--text-feedback-critical)" }}>{state.error}</Paragraph>;
        case "done":
            return null;
    }
}

function SignInSection({ provider }: { provider: ProviderInfo; }) {
    const [status, refresh] = useCredentialStatus(provider.id);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [login, setLogin] = useState<LoginState | null>(null);

    useEffect(() => {
        if (!sessionId) return;

        const interval = setInterval(async () => {
            const state = await Native.getLoginState(sessionId);
            setLogin(state);
            if (state.status === "done" || state.status === "error") {
                setSessionId(null);
                refresh();
            }
        }, LOGIN_POLL_MS);

        return () => {
            clearInterval(interval);
            Native.cancelLogin(sessionId);
        };
    }, [sessionId]);

    async function signIn() {
        setLogin({ status: "starting" });
        try {
            setSessionId(unwrap(await Native.startLogin(provider.id)));
        } catch (error) {
            setLogin({ status: "error", error: String(error) });
        }
    }

    async function signOut() {
        await Native.signOut(provider.id);
        setLogin(null);
        refresh();
    }

    return (
        <SettingsSection name="Account" id="account" description={`Sign in with your ${provider.name.replace(" (sign in)", "")} account. The login is stored encrypted outside Discord.`}>
            {status?.signedIn && !sessionId
                ? (
                    <div style={row}>
                        <Paragraph>Signed in{status.label && <> as <b>{status.label}</b></>}</Paragraph>
                        <Button size="small" variant="dangerSecondary" onClick={signOut}>Sign out</Button>
                    </div>
                )
                : (
                    <>
                        {login && <LoginProgress state={login} onSubmit={value => sessionId && Native.submitLoginInput(sessionId, value)} />}
                        {!sessionId && <Button style={{ marginTop: 8 }} onClick={signIn}>{login?.status === "error" ? "Try again" : "Sign in"}</Button>}
                        {sessionId && <Button style={{ marginTop: 8 }} variant="secondary" onClick={() => { setSessionId(null); setLogin(null); }}>Cancel</Button>}
                    </>
                )}
        </SettingsSection>
    );
}

const OTHER_MODEL = "\0other";

function ModelSection({ provider }: { provider: ProviderInfo; }) {
    const { model } = settings.use(["model"]);
    const listed = provider.models.some(m => m.id === model);
    // the text box is only for models missing from the list, or providers without one
    const [typing, setTyping] = useState(() => !listed && !!model);
    const showInput = !provider.models.length || typing;

    return (
        <SettingsSection name="Model" id="model" description="Small, fast models work best.">
            {provider.models.length > 0 && (
                <SearchableSelect
                    options={[
                        ...provider.models.map(({ id, name }) => ({ label: name === id ? id : `${name} (${id})`, value: id })),
                        { label: "Other model id...", value: OTHER_MODEL }
                    ]}
                    value={typing ? OTHER_MODEL : listed ? model : undefined}
                    placeholder={`Search ${provider.models.length} models`}
                    maxVisibleItems={8}
                    closeOnSelect
                    onChange={(id: string) => {
                        setTyping(id === OTHER_MODEL);
                        if (id !== OTHER_MODEL) settings.store.model = id;
                    }}
                />
            )}
            {showInput && (
                <div style={{ marginTop: provider.models.length ? 8 : 0 }}>
                    <TextInput value={model} onChange={(id: string) => settings.store.model = id} placeholder="Model id, like gpt-5-mini" />
                </div>
            )}
        </SettingsSection>
    );
}

export function ProviderSettings() {
    const { provider: providerId, baseUrl } = settings.use(["provider", "baseUrl"]);
    const [providers, error] = useAwaiter(async () => unwrap(await Native.getProviders()), { fallbackValue: null });
    const provider = providers?.find(p => p.id === providerId);

    function selectProvider(id: string) {
        settings.store.provider = id;
        settings.store.model = providers?.find(p => p.id === id)?.defaultModel ?? "";
    }

    return (
        <>
            <SettingsSection
                name="Provider"
                id="provider"
                description="LanguageTool is free. AI providers catch far more grammar mistakes and can suggest replies. Sign in with a subscription or use an API key."
                error={error ? `Couldn't load the provider list: ${error}` : null}
            >
                <SearchableSelect
                    options={providers?.map(({ id, name }) => ({ label: name, value: id })) ?? []}
                    value={providerId}
                    placeholder={providers ? `Search ${providers.length} providers` : "Loading providers..."}
                    maxVisibleItems={8}
                    closeOnSelect
                    onChange={selectProvider}
                />
            </SettingsSection>

            {provider?.needsBaseUrl && (
                <SettingsSection name="API URL" id="baseUrl" description={`Your provider's API URL, like ${provider.baseUrlHint}`}>
                    <TextInput value={baseUrl} onChange={(url: string) => settings.store.baseUrl = url} placeholder={provider.baseUrlHint} />
                </SettingsSection>
            )}
            {provider?.auth === "apiKey" && <ApiKeySection key={provider.id} provider={provider} />}
            {provider?.auth === "oauth" && <SignInSection key={provider.id} provider={provider} />}
            {provider && provider.auth !== "none" && <ModelSection key={provider.id} provider={provider} />}
        </>
    );
}
