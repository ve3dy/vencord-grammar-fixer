/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import type { ModelInfo } from "../types";
import { requestJson } from "./http";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_FILE = join(DATA_DIR, "GrammarFixer", "models.json");
const MAX_AGE_MS = 24 * 60 * 60_000;

export interface CatalogModel extends ModelInfo {
    /** Lowest reasoning effort the model accepts, sent to keep replies fast */
    effort?: string;
    /** The model has a thinking on/off switch */
    thinkingToggle?: boolean;
}

export interface CatalogProvider {
    id: string;
    name: string;
    wire: "openai" | "anthropic";
    url: string;
    models: CatalogModel[];
    defaultModel?: string;
}

// models.dev leaves out the URL for providers that have their own SDK
const KNOWN_URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
    mistral: "https://api.mistral.ai/v1",
    groq: "https://api.groq.com/openai/v1",
    xai: "https://api.x.ai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    togetherai: "https://api.together.xyz/v1",
    deepinfra: "https://api.deepinfra.com/v1/openai",
    perplexity: "https://api.perplexity.ai",
    cohere: "https://api.cohere.ai/compatibility/v1",
    venice: "https://api.venice.ai/api/v1",
    vercel: "https://ai-gateway.vercel.sh/v1",
    aihubmix: "https://aihubmix.com/v1"
};

const LOW_EFFORTS = ["none", "minimal", "low"];

interface RawModel {
    id: string;
    name?: string;
    status?: string;
    tool_call?: boolean;
    cost?: { input?: number; output?: number; };
    modalities?: { input?: string[]; output?: string[]; };
    reasoning_options?: { type: string; values?: string[]; }[];
}

interface RawProvider {
    id: string;
    name: string;
    npm?: string;
    api?: string;
    models: Record<string, RawModel>;
}

function toProvider(raw: RawProvider): CatalogProvider | null {
    const url = raw.api ?? KNOWN_URLS[raw.id];
    if (!url) return null;

    // chat models that only write text, so no embedding, image or audio models
    const usable = Object.values(raw.models).filter(model =>
        model.status !== "deprecated"
        && (model.modalities?.input?.includes("text") ?? true)
        && (model.modalities?.output ?? ["text"]).join() === "text"
    );
    if (!usable.length) return null;

    const models = usable
        .map<CatalogModel>(model => {
            const effort = model.reasoning_options?.find(option => option.type === "effort")?.values;
            return {
                id: model.id,
                name: model.name ?? model.id,
                effort: LOW_EFFORTS.find(value => effort?.includes(value)),
                thinkingToggle: model.reasoning_options?.some(option => option.type === "toggle") || undefined
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    // Grammar fixes are small, so default to the cheapest chat model. Tool support filters out embedding and guard models,
    // and "-latest" aliases are preferred because providers keep them working when they retire old versions.
    // Free models sort after paid ones because they are usually rate limited, unpriced (local) ones last
    const sortKey = ({ cost }: RawModel) => cost?.input == null || cost.output == null ? Infinity : cost.input + cost.output || Number.MAX_VALUE;
    const chat = usable.filter(model => model.tool_call);
    const pool = chat.length ? chat : usable;
    const aliases = pool.filter(model => model.id.endsWith("-latest"));
    const [cheapest] = (aliases.length ? aliases : pool).toSorted((a, b) => (sortKey(a) - sortKey(b)) || a.id.length - b.id.length);

    return {
        id: raw.id,
        name: raw.name,
        wire: raw.npm?.includes("anthropic") ? "anthropic" : "openai",
        url: url.replace(/\/+$/, ""),
        models,
        defaultModel: cheapest.id
    };
}

let cached: { fetchedAt: number; providers: CatalogProvider[]; } | undefined;

async function readCache() {
    try {
        return JSON.parse(await readFile(CACHE_FILE, "utf8")) as typeof cached;
    } catch {
        return undefined;
    }
}

export async function getCatalog() {
    cached ??= await readCache();
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached.providers;

    try {
        const raw = await requestJson<Record<string, RawProvider>>(CATALOG_URL);
        const providers = Object.values(raw)
            .map(toProvider)
            .filter(provider => provider !== null)
            .sort((a, b) => a.name.localeCompare(b.name));

        cached = { fetchedAt: Date.now(), providers };
        await mkdir(join(DATA_DIR, "GrammarFixer"), { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(cached));
    } catch (error) {
        // keep working offline with an outdated list
        if (!cached) throw error;
    }

    return cached.providers;
}
