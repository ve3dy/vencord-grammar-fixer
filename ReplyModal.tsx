/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextArea, useState } from "@webpack/common";

import { suggestReply } from "./api";
import { getDraft, setDraft } from "./draft";
import { cl } from "./styles";

function ReplyModal({ channelId, message, ...props }: RenderModalProps & { channelId: string; message: string; }) {
    // a started draft is usually what the user wants to say
    const [notes, setNotes] = useState(() => getDraft(channelId));
    const [reply, setReply] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function write() {
        setPending(true);
        setError(null);
        try {
            setReply(await suggestReply(message, notes));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(false);
        }
    }

    const canWrite = !pending && !!notes.trim();

    return (
        <Modal
            {...props}
            title="Suggest Reply"
            subtitle={pending ? "Writing a reply..." : error}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: props.onClose },
                reply
                    ? { text: "Rewrite", variant: "secondary", disabled: !canWrite, onClick: write }
                    : { text: "Write Reply", variant: "primary", disabled: !canWrite, onClick: write },
                ...(reply ? [{
                    text: "Use Reply",
                    variant: "primary",
                    disabled: pending || !reply.trim(),
                    onClick() {
                        setDraft(channelId, reply);
                        props.onClose();
                    }
                }] : [])
            ]}
        >
            <Paragraph className={cl("context")}>{message}</Paragraph>

            <Paragraph size="sm" weight="medium" className={cl("label")}>What do you want to say?</Paragraph>
            <TextArea
                value={notes}
                onChange={setNotes}
                rows={2}
                placeholder="Rough notes in any language, like: yes but I'll be 10 min late"
                autoFocus
            />

            {reply && (
                <>
                    <Paragraph size="sm" weight="medium" className={cl("label")}>Reply</Paragraph>
                    <TextArea value={reply} onChange={setReply} rows={4} disabled={pending} />
                </>
            )}
        </Modal>
    );
}

export function openReplyModal(channelId: string, message: string) {
    openModal(props => <ReplyModal {...props} channelId={channelId} message={message} />);
}
