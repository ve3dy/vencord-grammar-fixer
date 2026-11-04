/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

import { settings } from ".";
import { diff } from "./diff";
import { protectMarkup } from "./markup";
import type * as NativeApi from "./native";
import { fixInput, fixPrompt, replyInput, replyPrompt } from "./prompts";
import type { GrammarMatch, NativeResult } from "./types";

export const Native = VencordNative.pluginHelpers.GrammarFixer as PluginNative<typeof NativeApi>;

export function unwrap<T>(result: NativeResult<T>) {
    if (!result.ok) throw new Error(result.error);
    return result.value;
}

async function complete(system: string, text: string) {
    const { provider, model, baseUrl } = settings.store;
    if (!model) throw new Error("Pick a model in the GrammarFixer settings first.");

    const reply = unwrap(await Native.complete({ providerId: provider, model, baseUrl, system, text }));
    return reply.trim();
}

async function runCheck(text: string) {
    const { provider, picky, style } = settings.store;
    if (provider === "languagetool") return unwrap(await Native.checkGrammar(text, picky));

    const draft = protectMarkup(text);
    // only links, mentions, emojis or code, nothing to fix
    if (!/\p{L}/u.test(draft.text)) return [];

    const reply = await complete(fixPrompt(style), fixInput(draft.text));
    const fixed = draft.restore(reply.replace(/^<draft>\s*|\s*<\/draft>$/g, ""));
    // a reply much shorter than the message is an answer or a cut off reply, not a fix. Applying it would wipe the draft
    if (text.length > 20 && fixed.length < text.length * 0.4)
        throw new Error("The AI's reply doesn't look like a fixed message, try again or pick another model.");

    return diff(text, fixed);
}

let lastCheck: { key: string; result: Promise<GrammarMatch[]>; } | undefined;

/** Reuses the last check of the same text, so a check started when the pointer reaches the Fix button is ready sooner */
export function checkText(text: string) {
    const { provider, model, style, picky } = settings.store;
    const key = JSON.stringify([text, provider, model, style, picky]);

    if (lastCheck?.key !== key) {
        const result = runCheck(text);
        lastCheck = { key, result };
        // don't keep failures, opening the modal again should retry
        result.catch(() => {
            if (lastCheck?.result === result) lastCheck = undefined;
        });
    }

    return lastCheck.result;
}

export async function suggestReply(message: string, notes: string) {
    const draft = protectMarkup(notes.trim());
    return draft.restore(await complete(replyPrompt(settings.store.style), replyInput(message, draft.text)));
}
