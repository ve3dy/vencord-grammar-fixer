/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { DraftStore, DraftType } from "@webpack/common";

const DraftActions = findByPropsLazy("clearDraft", "saveDraft");

export function getDraft(channelId: string): string {
    return DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "";
}

export function setDraft(channelId: string, text: string) {
    DraftActions.clearDraft(channelId, DraftType.ChannelMessage);
    // the chat input only picks up a new draft after it was cleared
    requestAnimationFrame(() => DraftActions.saveDraft(channelId, text, DraftType.ChannelMessage));
}
