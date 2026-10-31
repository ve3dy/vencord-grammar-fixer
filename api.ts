/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

import { settings } from ".";
import { diff } from "./diff";
import type * as NativeApi from "./native";
import { fixPrompt, replyInput, replyPrompt } from "./prompts";
import type { NativeResult } from "./types";

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

export async function checkText(text: string) {
    const { provider, picky, style } = settings.store;
    if (provider === "languagetool") return unwrap(await Native.checkGrammar(text, picky));

    const fixed = await complete(fixPrompt(style), text);
    // a reply much shorter than the message is an answer or a cut off reply, not a fix. Applying it would wipe the draft
    if (text.length > 20 && fixed.length < text.length * 0.4)
        throw new Error("The AI's reply doesn't look like a fixed message, try again or pick another model.");

    return diff(text, fixed);
}

export function suggestReply(message: string, draft: string) {
    return complete(replyPrompt(settings.store.style, !!draft.trim()), replyInput(message, draft.trim()));
}
