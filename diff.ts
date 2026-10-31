/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { GrammarMatch } from "./types";

export interface Fix {
    offset: number;
    length: number;
    value: string;
}

const TOKEN = /[\p{L}\p{N}'’]+|\s+|[^\p{L}\p{N}\s]/gu;

/** Turns the AI's fixed message into LanguageTool-style matches, so each change can be reviewed on its own */
export function diff(original: string, fixed: string) {
    const a = original.match(TOKEN) ?? [];
    const b = fixed.match(TOKEN) ?? [];

    // lcs[i][j] is the length of the longest common subsequence of a[i:] and b[j:]
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

    const matches: GrammarMatch[] = [];
    let i = 0, j = 0, offset = 0;

    while (i < a.length || j < b.length) {
        if (a[i] === b[j]) {
            offset += a[i++].length;
            j++;
            continue;
        }

        const start = offset;
        let value = "";
        while (a[i] !== b[j]) {
            if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) value += b[j++];
            else offset += a[i++].length;
        }

        const last = matches.at(-1);
        const gap = last ? original.slice(last.offset + last.length, start) : "";

        // join changes that are only separated by spaces, so "flash lite" -> "Flash Lite" is one change
        if (last && !gap.trim()) {
            last.replacements[0].value += gap + value;
            last.length = offset - last.offset;
        } else {
            matches.push({ message: "", offset: start, length: offset - start, replacements: [{ value }] });
        }
    }

    return matches;
}

export function applyFixes(text: string, fixes: Fix[]) {
    let end = text.length;

    for (const { offset, length, value } of fixes.toSorted((a, b) => b.offset - a.offset)) {
        // LanguageTool can return overlapping matches, skip the ones that collide with an applied fix
        if (offset + length > end) continue;

        text = text.slice(0, offset) + value + text.slice(offset + length);
        end = offset;
    }

    return text;
}
