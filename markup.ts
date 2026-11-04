/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// code blocks, inline code, mentions, channels, custom emojis, timestamps, commands and links. Trailing punctuation isn't part of a link
const MARKUP = /```[\s\S]*?```|`[^`\n]+`|<(?:@[!&]?|#|\/|a?:|t:|id:)[^<>\n]*>|<?https?:\/\/[^\s<>]*[^\s<>.,:;!?"')\]]>?/g;
const PLACEHOLDER = /⟦(\d+)⟧/g;

/**
 * Swaps links, mentions, emojis and code for numbered placeholders before the message goes to the AI.
 * They have to come back byte for byte, and a message that starts with a link makes models introduce it ("Here's the link: ...").
 */
export function protectMarkup(text: string) {
    const markup: string[] = [];
    const masked = text.replace(MARKUP, match => `⟦${markup.push(match)}⟧`);

    function restore(reply: string) {
        const seen = new Set<number>();
        let valid = true;

        const restored = reply.replace(PLACEHOLDER, (placeholder, n: string) => {
            const index = Number(n) - 1;
            if (index >= markup.length || seen.has(index)) valid = false;
            seen.add(index);
            return markup[index] ?? placeholder;
        });

        if (!valid || seen.size !== markup.length)
            throw new Error("The AI changed a link, mention, emoji or code block, try again or pick another model.");

        return restored;
    }

    return { text: masked, restore };
}
