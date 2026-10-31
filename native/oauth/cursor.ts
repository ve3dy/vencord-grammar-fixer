/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomUUID } from "crypto";
import { connect, type IncomingHttpHeaders } from "http2";

import { requestJson } from "../http";
import type { OAuthCredentials, OAuthProvider } from "./types";
import { decodeJwt, pkce, sleep } from "./util";

const API_URL = "https://api2.cursor.sh";
/** Released Cursor agent CLI build; the service gates protocol features on it */
const CLIENT_VERSION = "cli-2026.09.02-c22c1a3";
const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const RUN_TIMEOUT_MS = 120_000;
const CONNECT_END_STREAM = 0x02;

// --- minimal protobuf wire encoding for the agent.v1 messages one chat turn needs ---

type Field = Uint8Array | Uint8Array[];

function varint(value: number) {
    const bytes: number[] = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value = Math.floor(value / 128);
    }
    bytes.push(value);
    return Uint8Array.from(bytes);
}

const tag = (field: number, wireType: number) => varint(field * 8 + wireType);
const lengthDelimited = (field: number, data: Uint8Array) => Buffer.concat([tag(field, 2), varint(data.length), data]);
const str = (field: number, value: string) => lengthDelimited(field, Buffer.from(value));
const uint = (field: number, value: number) => Buffer.concat([tag(field, 0), varint(value)]);
/** Embedded message from already encoded fields; an empty message still sets a oneof */
const msg = (field: number, ...fields: Field[]) => lengthDelimited(field, Buffer.concat(fields.flat()));

interface WireField {
    no: number;
    /** varint value, or undefined for length-delimited fields */
    int?: number;
    bytes?: Uint8Array;
}

function decode(buf: Uint8Array): WireField[] {
    const fields: WireField[] = [];
    let pos = 0;
    const readVarint = () => {
        let result = 0;
        let factor = 1;
        while (true) {
            if (pos >= buf.length) throw new Error("Truncated protobuf message");
            const byte = buf[pos++];
            result += (byte & 0x7f) * factor;
            if (byte < 0x80) return result;
            factor *= 128;
        }
    };
    while (pos < buf.length) {
        const key = readVarint();
        const no = Math.floor(key / 8);
        switch (key & 7) {
            case 0:
                fields.push({ no, int: readVarint() });
                break;
            case 1:
                pos += 8;
                break;
            case 2: {
                const length = readVarint();
                fields.push({ no, bytes: buf.subarray(pos, pos + length) });
                pos += length;
                break;
            }
            case 5:
                pos += 4;
                break;
            default:
                throw new Error("Unsupported protobuf wire type");
        }
    }
    return fields;
}

const field = (fields: WireField[], no: number) => fields.find(f => f.no === no);
const text = (bytes: Uint8Array | undefined) => bytes ? Buffer.from(bytes).toString("utf8") : "";

function frame(data: Uint8Array) {
    const out = Buffer.alloc(5 + data.length);
    out.writeUInt32BE(data.length, 1);
    out.set(data, 5);
    return out;
}

// --- request ---

interface RunRequest {
    model: string;
    modelName: string;
    system: string;
    text: string;
}

function buildRunRequest({ model, modelName, system, text: userText }: RunRequest) {
    // Cursor reads the system prompt from blobs it requests back over the KV channel
    const systemJson = Buffer.from(JSON.stringify({ role: "system", content: system || "You are a helpful assistant." }));
    const blobId = createHash("sha256").update(systemJson).digest();
    const blobs = new Map([[blobId.toString("hex"), systemJson]]);

    const runRequest = msg(1,
        msg(1, lengthDelimited(1, blobId)),
        msg(2, msg(1, msg(1, str(1, userText), str(2, randomUUID())))),
        msg(3, str(1, model), str(3, model), str(4, modelName)),
        msg(9, str(1, model)),
        str(5, randomUUID())
    );
    return { runRequest, blobs };
}

/** The request context the server asks for before running: the system prompt as a global user rule, no tools */
function requestContextResult(system: string) {
    const rules = system ? [msg(2,
        str(1, "/omp/system-prompt/0.mdc"),
        str(2, system),
        msg(3, msg(1)),
        uint(4, 2)
    )] : [];
    return msg(10, msg(1, msg(1, rules)));
}

function connectError(payload: Uint8Array) {
    try {
        const error = JSON.parse(text(payload))?.error;
        if (!error) return undefined;
        return new Error(`Cursor returned an error: ${error.message ?? error.code ?? "unknown error"}`);
    } catch {
        return new Error("Cursor returned an unreadable error");
    }
}

/** Runs one agent turn over Connect bidi streaming (HTTP/2) and returns the streamed text */
async function runCursorTurn(accessToken: string, req: RunRequest & { signal: AbortSignal; }) {
    const { runRequest, blobs } = buildRunRequest(req);
    const { promise, resolve, reject } = Promise.withResolvers<string>();

    const client = connect(API_URL);
    const stream = client.request({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/Run",
        "content-type": "application/connect+proto",
        authorization: `Bearer ${accessToken}`,
        "x-cursor-client-type": "cli",
        "x-cursor-client-version": CLIENT_VERSION,
        "x-ghost-mode": "true",
        "connect-protocol-version": "1",
        "x-request-id": randomUUID(),
        te: "trailers"
    });

    let output = "";
    let status = 0;
    const errorBody: Buffer[] = [];
    let pending = Buffer.alloc(0);

    const write = (data: Uint8Array) => {
        if (!stream.closed && !stream.writableEnded) stream.write(frame(data));
    };
    const heartbeat = setInterval(() => write(msg(7)), 5000);
    const timeout = setTimeout(() => finish(new Error("Cursor took too long to answer")), RUN_TIMEOUT_MS);
    const onAbort = () => finish(new Error("Request cancelled"));
    req.signal.addEventListener("abort", onAbort, { once: true });

    function finish(error?: Error) {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        req.signal.removeEventListener("abort", onAbort);
        stream.close();
        client.close();
        if (error) reject(error);
        else if (output) resolve(output);
        else reject(new Error("Cursor didn't return any text"));
    }

    const handleServerMessage = (fields: WireField[]) => {
        const interaction = field(fields, 1)?.bytes;
        if (interaction) {
            const update = decode(interaction);
            const delta = field(update, 1)?.bytes;
            if (delta) output += text(field(decode(delta), 1)?.bytes);
            if (field(update, 14)) finish();
            return;
        }

        const exec = field(fields, 2)?.bytes;
        if (exec) {
            const execFields = decode(exec);
            const id = field(execFields, 1)?.int ?? 0;
            const execId = text(field(execFields, 15)?.bytes);
            const header = [id ? uint(1, id) : [], execId ? str(15, execId) : []];
            if (field(execFields, 10)) {
                write(msg(2, ...header, requestContextResult(req.system)));
            } else {
                // no local tools: fail the call in band like Cursor's own client does for unhandled exec frames
                write(msg(5, msg(2, id ? uint(1, id) : [], str(2, "Tools are not available in this client"), str(4, "unsupported"))));
                write(msg(5, msg(1, id ? uint(1, id) : [])));
            }
            return;
        }

        const kv = field(fields, 4)?.bytes;
        if (kv) {
            const kvFields = decode(kv);
            const id = field(kvFields, 1)?.int ?? 0;
            const idField = id ? uint(1, id) : [];
            const get = field(kvFields, 2)?.bytes;
            const set = field(kvFields, 3)?.bytes;
            if (get) {
                const blob = blobs.get(Buffer.from(field(decode(get), 1)?.bytes ?? []).toString("hex"));
                write(msg(3, idField, msg(2, blob ? lengthDelimited(1, blob) : [])));
            } else if (set) {
                const setFields = decode(set);
                blobs.set(Buffer.from(field(setFields, 1)?.bytes ?? []).toString("hex"), Buffer.from(field(setFields, 2)?.bytes ?? []));
                write(msg(3, idField, msg(3)));
            }
        }
    };

    stream.on("response", (headers: IncomingHttpHeaders) => {
        status = Number(headers[":status"]);
    });
    stream.on("data", (chunk: Buffer) => {
        if (status !== 200) {
            errorBody.push(chunk);
            return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
            const length = pending.readUInt32BE(1);
            if (pending.length < 5 + length) break;
            const flags = pending[0];
            const payload = pending.subarray(5, 5 + length);
            pending = pending.subarray(5 + length);
            if (flags & CONNECT_END_STREAM) {
                finish(connectError(payload));
                return;
            }
            try {
                handleServerMessage(decode(payload));
            } catch (e) {
                finish(e instanceof Error ? e : new Error(String(e)));
                return;
            }
        }
    });
    stream.on("end", () => {
        if (status !== 200) {
            const body = Buffer.concat(errorBody);
            finish(connectError(body) ?? new Error(`Cursor returned ${status}: ${text(body).slice(0, 300)}`));
        } else finish();
    });
    stream.on("error", error => finish(error));
    client.on("error", error => finish(error));

    write(runRequest);
    return promise;
}

// --- auth ---

function tokenExpiry(token: string) {
    const { exp } = decodeJwt(token);
    return typeof exp === "number" ? exp * 1000 - 5 * 60_000 : Date.now() + 3600_000;
}

/** Email of the account, read from the profile the Cursor CLI uses. Undefined when the lookup fails */
async function accountEmail(accessToken: string, signal: AbortSignal) {
    const subject = decodeJwt(accessToken).sub;
    if (typeof subject !== "string") return undefined;
    try {
        const me = await requestJson(`${API_URL}/aiserver.v1.DashboardService/GetMe`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`,
                "Connect-Protocol-Version": "1",
                "Content-Type": "application/json"
            },
            body: "{}",
            signal: AbortSignal.any([signal, AbortSignal.timeout(3000)])
        });
        return me?.authId === subject && typeof me.email === "string" ? me.email.trim() || undefined : undefined;
    } catch {
        return undefined;
    }
}

export const cursor: OAuthProvider = {
    id: "cursor",
    name: "Cursor",
    models: [
        { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
        { id: "default", name: "Auto" },
        { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        { id: "claude-sonnet-5-low", name: "Claude Sonnet 5 (low)" },
        { id: "grok-code-fast-1", name: "Grok Code Fast 1" }
    ],
    defaultModel: "composer-2.5-fast",

    async login(ctx) {
        const { verifier, challenge } = pkce();
        const uuid = randomUUID();
        const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
        ctx.openBrowser(`https://cursor.com/loginDeepControl?${params}`);

        // the login page reports back by making the poll endpoint answer; 404 means not yet
        let delay = 1000;
        let errors = 0;
        for (let attempt = 0; attempt < 150; attempt++) {
            await sleep(delay, ctx.signal);
            try {
                const res = await fetch(`${API_URL}/auth/poll?${new URLSearchParams({ uuid, verifier })}`, {
                    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
                });
                if (res.status === 404) {
                    errors = 0;
                    delay = Math.min(delay * 1.2, 10_000);
                    continue;
                }
                if (!res.ok) throw new Error(`Cursor sign in poll failed: ${res.status}`);

                const { accessToken, refreshToken } = await res.json();
                if (typeof accessToken !== "string") throw new Error("Cursor didn't return an access token");
                return {
                    access: accessToken,
                    refresh: refreshToken,
                    expires: tokenExpiry(accessToken),
                    label: await accountEmail(accessToken, ctx.signal)
                };
            } catch (e) {
                if (ctx.signal.aborted) throw e;
                if (++errors >= 3) throw new Error(`Cursor sign in failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        throw new Error("Cursor sign in timed out");
    },

    async refresh(creds, signal): Promise<OAuthCredentials> {
        const data = await requestJson(`${API_URL}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }),
            signal
        });
        // Cursor answers a session it won't renew with 200, an empty token and `shouldLogout`
        if (data?.shouldLogout === true) throw new Error("Cursor ended this session, sign in again");
        if (typeof data?.access_token !== "string" || !data.access_token) throw new Error("Cursor didn't return an access token");

        return {
            ...creds,
            access: data.access_token,
            // Cursor usually doesn't rotate the refresh token; the IDE keeps the stored one
            refresh: data.refresh_token || creds.refresh,
            expires: tokenExpiry(data.access_token),
            label: creds.label ?? await accountEmail(data.access_token, signal)
        };
    },

    complete(creds, { model, system, text, signal }) {
        const modelName = cursor.models.find(m => m.id === model)?.name ?? model;
        return runCursorTurn(creds.access, { model, modelName, system, text, signal });
    }
};
