/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";

import { request } from "../http";
import type { LoginContext, OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt } from "./util";

const BASE_URL = "https://www.perplexity.ai";
const API_VERSION = "2.18";
// Perplexity's macOS app identity, which the HTTP auth endpoints and the ask endpoint expect
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const SESSION_COOKIES = ["__Secure-next-auth.session-token", "next-auth.session-token"];

interface VerifyResponse {
    token?: string;
    challenge_token?: string;
    status?: string;
    error_code?: string;
    text?: string;
}

/** fetch that keeps the cookies Perplexity sets between the sign in steps */
function cookieSession(signal: AbortSignal) {
    const cookies = new Map<string, string>();
    const send = async (path: string, body?: object) => {
        const headers: Record<string, string> = { "User-Agent": APP_USER_AGENT, "X-App-ApiVersion": API_VERSION };
        if (body) headers["Content-Type"] = "application/json";
        if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

        const res = await fetch(BASE_URL + path, {
            method: body ? "POST" : "GET",
            headers,
            body: body && JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        });
        for (const setCookie of res.headers.getSetCookie()) {
            const [pair, ...attributes] = setCookie.split(";");
            const index = pair.indexOf("=");
            if (index < 1) continue;
            const name = pair.slice(0, index).trim();
            const expired = attributes.some(attr => /^\s*max-age=0\s*$/i.test(attr));
            if (expired) cookies.delete(name);
            else cookies.set(name, pair.slice(index + 1).trim());
        }
        return res;
    };
    return { send, cookies };
}

async function verify(res: Response, step: string): Promise<VerifyResponse> {
    const text = await res.text();
    let data: VerifyResponse = {};
    try {
        data = JSON.parse(text);
    } catch { }
    if (!res.ok) throw new Error(`Perplexity ${step} failed (${res.status}): ${data.text ?? data.error_code ?? data.status ?? text.slice(0, 300)}`);
    return data;
}

async function askCode(ctx: LoginContext, message: string, error: string) {
    const value = (await ctx.prompt(message)).trim();
    if (!value) throw new Error(error);
    return value;
}

// Email OTP sign in like Perplexity's apps; the session JWT it returns doesn't expire and can't be refreshed
async function login(ctx: LoginContext): Promise<OAuthCredentials> {
    const email = await askCode(ctx, "Enter your Perplexity email address", "An email address is required");
    const { send, cookies } = cookieSession(ctx.signal);

    const csrfRes = await send("/api/auth/csrf");
    if (!csrfRes.ok) throw new Error(`Perplexity CSRF request failed (${csrfRes.status})`);
    const { csrfToken } = await csrfRes.json();
    if (typeof csrfToken !== "string" || !csrfToken) throw new Error("Perplexity didn't return a CSRF token");

    const sendRes = await send("/api/auth/signin-email", { email, csrfToken });
    if (!sendRes.ok) throw new Error(`Perplexity couldn't send the sign in code (${sendRes.status}): ${(await sendRes.text()).slice(0, 300)}`);

    const otp = await askCode(ctx, "Enter the code Perplexity sent to your email", "The code is required");
    let data = await verify(await send("/api/auth/signin-otp", { email, otp, csrfToken }), "code verification");

    if (data.status === "totp_challenge_required" && data.challenge_token) {
        const code = await askCode(ctx, "Enter the code from your authenticator app", "The authenticator code is required");
        data = await verify(await send("/api/auth/totp/challenge-verify", { token: data.challenge_token, code }), "authenticator verification");
        if (!data.token) {
            const session = SESSION_COOKIES.map(name => cookies.get(name)).find(Boolean);
            data = { token: session, status: "success" };
        }
    }

    const token = data.token ?? data.challenge_token;
    if (!token || data.error_code || (data.status && data.status !== "success"))
        throw new Error(`Perplexity rejected the sign in: ${data.text ?? data.error_code ?? data.status ?? "no session token"}`);

    const { exp } = decodeJwt(token);
    return { access: token, expires: typeof exp === "number" ? exp * 1000 - 5 * 60_000 : undefined, label: email };
}

interface AskBlock {
    intended_usage?: string;
    markdown_block?: { chunks?: string[]; chunk_starting_offset?: number; answer?: string; };
}

interface AskEvent {
    status?: string;
    final?: boolean;
    text?: string;
    blocks?: AskBlock[];
    error_code?: string;
    error_message?: string;
}

/** Folds one streamed snapshot into the answer blocks, which arrive as chunk patches */
function mergeBlocks(blocks: Map<string, AskBlock>, event: AskEvent) {
    for (const block of event.blocks ?? []) {
        if (!block.intended_usage) continue;
        const prev = blocks.get(block.intended_usage);
        const incoming = block.markdown_block;
        if (!incoming) {
            blocks.set(block.intended_usage, { ...prev, ...block });
            continue;
        }

        const markdown = { ...prev?.markdown_block, ...incoming };
        if (incoming.chunks?.length) {
            const offset = incoming.chunk_starting_offset ?? 0;
            markdown.chunks = [...(prev?.markdown_block?.chunks ?? []).slice(0, offset), ...incoming.chunks];
        }
        blocks.set(block.intended_usage, { ...prev, ...block, markdown_block: markdown });
    }
}

function answerOf(blocks: Map<string, AskBlock>, text: string | undefined) {
    const markdown = [...blocks.values()].find(block => block.intended_usage?.includes("markdown") && block.markdown_block)?.markdown_block
        ?? blocks.get("ask_text")?.markdown_block;
    const fromChunks = markdown?.chunks?.join("");
    if (fromChunks) return fromChunks;
    if (markdown?.answer) return markdown.answer;
    return parseTextAnswer(text);
}

/** Older ask responses carry the answer as JSON steps inside `text` */
function parseTextAnswer(text: string | undefined) {
    if (!text) return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return text;
    }
    if (!Array.isArray(parsed)) return text;
    for (const step of parsed) {
        const answer = step?.content?.answer;
        if (typeof answer !== "string" || !answer) continue;
        try {
            const payload = JSON.parse(answer);
            if (typeof payload?.answer === "string" && payload.answer) return payload.answer;
        } catch { }
        return answer;
    }
    return text;
}

export const perplexity: OAuthProvider = {
    id: "perplexity",
    name: "Perplexity (Pro/Max)",
    // the consumer ask endpoint picks its model by `model_preference`; omp only uses Sonar ("experimental")
    models: [{ id: "experimental", name: "Sonar" }],
    defaultModel: "experimental",
    login,

    async complete(creds, { model, system, text, signal }) {
        // the ask endpoint has no system message slot
        const query = `${system}\n\n${text}`;
        const res = await request(`${BASE_URL}/rest/sse/perplexity_ask`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                Origin: BASE_URL,
                Referer: `${BASE_URL}/`,
                "User-Agent": APP_USER_AGENT,
                "X-Request-ID": randomUUID(),
                // the ask endpoint ignores bearer tokens; the session JWT goes in the next-auth cookie
                Cookie: `__Secure-next-auth.session-token=${creds.access}`,
                "X-App-ApiClient": "default",
                "X-App-ApiVersion": API_VERSION,
                "X-Perplexity-Request-Reason": "submit"
            },
            body: JSON.stringify({
                query_str: query,
                params: {
                    query_str: query,
                    search_focus: "internet",
                    mode: "copilot",
                    model_preference: model,
                    sources: ["web"],
                    attachments: [],
                    frontend_uuid: randomUUID(),
                    frontend_context_uuid: randomUUID(),
                    version: API_VERSION,
                    language: "en-US",
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
                    search_recency_filter: null,
                    is_incognito: true,
                    use_schematized_api: true,
                    // the native app's defaults: lets the backend skip web retrieval for text it can answer directly
                    skip_search_enabled: true,
                    always_search_override: false,
                    prompt_source: "user",
                    source: "default",
                    local_search_enabled: false,
                    should_ask_for_mcp_tool_confirmation: false,
                    supports_tool_approval_modal: false,
                    force_enable_browser_agent: false,
                    is_local_browser_available: false,
                    is_local_browser_allowed: false
                }
            }),
            signal
        });

        return readAnswer(res);
    }
};

async function readAnswer(res: Response) {
    const blocks = new Map<string, AskBlock>();
    let lastText: string | undefined;
    let answer = "";

    for await (const event of readSse(res)) {
        if (event.error_code) throw new Error(`Perplexity returned an error: ${event.error_message ?? event.error_code}`);
        mergeBlocks(blocks, event);
        if (typeof event.text === "string") lastText = event.text;
        answer = answerOf(blocks, lastText) || answer;
        if (event.final || event.status === "COMPLETED") break;
    }

    if (!answer) throw new Error("Perplexity didn't return any text");
    return answer;
}

async function* readSse(res: Response): AsyncGenerator<AskEvent> {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
            const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            try {
                yield JSON.parse(data);
            } catch { }
        }
    }
}
