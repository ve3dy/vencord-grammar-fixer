/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, type NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings, Settings } from "@api/Settings";
import definePlugin, { type IconComponent, OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";

import { Native } from "./api";
import { getDraft } from "./draft";
import { openFixModal } from "./FixModal";
import { styles } from "./prompts";
import { ProviderSettings } from "./ProviderSettings";
import { openReplyModal } from "./ReplyModal";

export const settings = definePluginSettings({
    providerSettings: {
        type: OptionType.COMPONENT,
        component: ProviderSettings
    },
    provider: {
        type: OptionType.STRING,
        description: "Provider id",
        default: "languagetool",
        hidden: true
    },
    model: {
        type: OptionType.STRING,
        description: "Model id",
        default: "",
        hidden: true
    },
    baseUrl: {
        type: OptionType.STRING,
        description: "API URL for custom providers",
        default: "",
        hidden: true
    },
    style: {
        type: OptionType.SELECT,
        description: "How the AI should fix your messages and write replies",
        options: Object.entries(styles).map(([value, { label }]) => ({ label, value: value as keyof typeof styles, default: value === "minimal" }))
    },
    picky: {
        type: OptionType.BOOLEAN,
        description: "Also flag style issues, like wordy or redundant phrases",
        default: false
    }
}, {
    style: { hidden() { return this.store.provider === "languagetool"; } },
    picky: { hidden() { return this.store.provider !== "languagetool"; } }
});

const GrammarFixerIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className}>
        <path fill="currentColor" d="M12.45 16h2.09L9.43 3H7.57L2.46 16h2.09l1.12-3h5.64l1.14 3Zm-6.02-5L8.5 5.48 10.57 11H6.43Zm15.16.59-8.09 8.09L9.83 16l-1.41 1.41 5.09 5.09L23 13l-1.41-1.41Z" />
    </svg>
);

const FixButton: ChatBarButtonFactory = ({ isAnyChat, isEmpty, channel }) => {
    if (!isAnyChat || isEmpty) return null;

    return (
        <ChatBarButton
            tooltip="Fix Grammar"
            onClick={() => {
                const draft = getDraft(channel.id);
                if (draft.trim()) openFixModal(channel.id, draft);
            }}
        >
            <GrammarFixerIcon />
        </ChatBarButton>
    );
};

const canSuggestReply = (message: Message) => !!message.content?.trim() && settings.store.provider !== "languagetool";

const messageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!canSuggestReply(message)) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    group?.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-grammar-fixer-reply"
            label="Suggest Reply"
            icon={GrammarFixerIcon}
            action={() => openReplyModal(message.channel_id, message.content)}
        />
    ));
};

// Before the rewrite, API keys were stored in plain text in settings.json. Move them into the encrypted native store
async function migrateLegacySettings() {
    const legacy = Settings.plugins.GrammarFixer as Record<string, any>;
    if (!("writingStyle" in legacy || "apiKey" in legacy || "endpoint" in legacy)) return;

    const provider = { gemini: "google", openai: legacy.endpoint ? "custom" : "openai", local: "custom" }[legacy.provider as string] ?? "languagetool";
    if (legacy.apiKey && provider !== "languagetool") await Native.setApiKey(provider, legacy.apiKey);

    settings.store.provider = provider;
    settings.store.baseUrl = provider === "custom" ? String(legacy.endpoint ?? "").replace(/\/chat\/completions\/?$/, "") : "";
    settings.store.style = ({ casual: "casual", punchy: "concise", formal: "formal" } as const)[legacy.writingStyle as string] ?? "minimal";

    for (const key of ["apiKey", "endpoint", "writingStyle", "customAuthKind", "customApiKey", "customResponseTextPath"])
        delete legacy[key];
}

export default definePlugin({
    name: "GrammarFixer",
    description: "Fix the grammar of your messages and get reply suggestions, with LanguageTool or any AI provider: sign in with a subscription or use an API key",
    authors: [{ name: "veedy", id: 337585778140119041n }],
    tags: ["Chat", "Utility"],
    settings,

    contextMenus: {
        message: messageContextMenu
    },

    messagePopoverButton: {
        icon: GrammarFixerIcon,
        render(message: Message) {
            if (!canSuggestReply(message)) return null;

            return {
                label: "Suggest Reply",
                icon: GrammarFixerIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => openReplyModal(message.channel_id, message.content)
            };
        }
    },

    chatBarButton: {
        icon: GrammarFixerIcon,
        render: FixButton
    },

    start: migrateLegacySettings
});
