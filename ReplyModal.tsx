/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { useAwaiter, useForceUpdater } from "@utils/react";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextArea, useState } from "@webpack/common";

import { suggestReply } from "./api";
import { getDraft, setDraft } from "./draft";
import { cl } from "./styles";

function ReplyModal({ channelId, message, ...props }: RenderModalProps & { channelId: string; message: string; }) {
    const [draft] = useState(() => getDraft(channelId));
    const [edited, setEdited] = useState<string | null>(null);
    const [signal, regenerate] = useForceUpdater(true);
    const [reply, error, pending] = useAwaiter(() => suggestReply(message, draft), {
        fallbackValue: "",
        deps: [signal],
        onSuccess: () => setEdited(null)
    });

    const text = edited ?? reply;

    return (
        <Modal
            {...props}
            title="Suggest Reply"
            subtitle={pending ? "Writing a reply..." : error ? String(error.message ?? error) : draft.trim() ? "Based on your draft." : null}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: props.onClose },
                { text: "Try Again", variant: "secondary", disabled: pending, onClick: regenerate },
                {
                    text: draft.trim() ? "Replace Draft" : "Use Reply",
                    variant: "primary",
                    disabled: pending || !text.trim(),
                    onClick() {
                        setDraft(channelId, text);
                        props.onClose();
                    }
                }
            ]}
        >
            <Paragraph className={cl("context")}>{message}</Paragraph>
            <TextArea value={text} onChange={setEdited} rows={4} disabled={pending} />
        </Modal>
    );
}

export function openReplyModal(channelId: string, message: string) {
    openModal(props => <ReplyModal {...props} channelId={channelId} message={message} />);
}
