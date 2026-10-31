/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const REQUEST_TIMEOUT_MS = 60_000;

export class HttpError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

function errorMessage(body: string) {
    try {
        let data = JSON.parse(body);
        // Gemini wraps errors in an array
        if (Array.isArray(data)) data = data[0];
        const message = data?.error?.message ?? data?.error_description ?? data?.message ?? data?.detail ?? data?.error;
        if (typeof message === "string") return message;
    } catch { }

    return body.slice(0, 300) || undefined;
}

/** fetch with a timeout that throws {@link HttpError} with the server's message on non-2xx responses */
export async function request(url: string, init: RequestInit = {}) {
    const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    const res = await fetch(url, { ...init, signal });
    if (!res.ok) {
        const message = errorMessage(await res.text()) ?? res.statusText;
        throw new HttpError(`${new URL(url).host} returned ${res.status}: ${message}`, res.status);
    }

    return res;
}

export async function requestJson<T = any>(url: string, init?: RequestInit): Promise<T> {
    return (await request(url, init)).json();
}

export interface ChatRequest {
    /** Full endpoint, like https://api.openai.com/v1/chat/completions */
    url: string;
    headers?: Record<string, string>;
    model: string;
    system: string;
    text: string;
    /** Extra fields merged into the body */
    body?: object;
    signal?: AbortSignal;
}

export async function openAiChat({ url, headers, model, system, text, body, signal }: ChatRequest) {
    const data = await requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: text }
            ],
            ...body
        }),
        signal
    });

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content) return content;
    // some providers return content parts
    if (Array.isArray(content)) return content.map(part => part?.text ?? "").join("");
    throw new Error(`${new URL(url).host} didn't return any text`);
}

export async function anthropicMessages({ url, headers, model, system, text, body, signal }: ChatRequest) {
    const data = await requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...headers },
        body: JSON.stringify({
            model,
            max_tokens: 4096,
            system,
            messages: [{ role: "user", content: text }],
            ...body
        }),
        signal
    });

    const content: string | undefined = data?.content
        ?.filter((part: { type: string; }) => part.type === "text")
        .map((part: { text: string; }) => part.text)
        .join("");
    if (content) return content;
    throw new Error(`${new URL(url).host} didn't return any text`);
}
