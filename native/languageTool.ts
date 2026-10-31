/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { GrammarMatch } from "../types";
import { requestJson } from "./http";

// code, custom emojis, mentions, timestamps and links
const DISCORD_MARKUP = /```[\s\S]*?```|`[^`\n]+`|<a?:\w+:\d+>|<(?:@[!&]?|#)\d+>|<t:-?\d+(?::[tTdDfFR])?>|https?:\/\/\S+/g;

function annotate(text: string) {
    const annotation: ({ text: string; } | { markup: string; interpretAs: string; })[] = [];
    let last = 0;

    for (const { 0: markup, index } of text.matchAll(DISCORD_MARKUP)) {
        if (index > last) annotation.push({ text: text.slice(last, index) });
        // without a stand-in word, LanguageTool flags the spaces left around the markup
        annotation.push({ markup, interpretAs: "X" });
        last = index + markup.length;
    }

    if (last < text.length) annotation.push({ text: text.slice(last) });
    return annotation;
}

export async function checkWithLanguageTool(text: string, picky: boolean): Promise<GrammarMatch[]> {
    const data = await requestJson("https://api.languagetool.org/v2/check", {
        method: "POST",
        body: new URLSearchParams({
            data: JSON.stringify({ annotation: annotate(text) }),
            language: "auto",
            level: picky ? "picky" : "default"
        })
    });

    return data.matches.map(({ message, offset, length, replacements }: GrammarMatch) => ({ message, offset, length, replacements }));
}
