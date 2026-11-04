/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { useAwaiter } from "@utils/react";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useState } from "@webpack/common";

import { checkText } from "./api";
import { applyFixes, type Fix } from "./diff";
import { setDraft } from "./draft";
import { cl } from "./styles";
import type { GrammarMatch } from "./types";

const CONTEXT_LENGTH = 40;

/** About CONTEXT_LENGTH characters around the issue, without cutting words in half */
function contextBounds(text: string, offset: number, length: number) {
    let start = Math.max(0, offset - CONTEXT_LENGTH);
    if (start > 0 && /\S/.test(text[start - 1])) {
        const space = text.slice(start, offset).search(/\s/);
        start = space === -1 ? offset : start + space + 1;
    }

    const issueEnd = offset + length;
    let end = Math.min(text.length, issueEnd + CONTEXT_LENGTH);
    if (end < text.length && /\S/.test(text[end])) {
        const space = text.slice(issueEnd, end).search(/\s\S*$/);
        end = space === -1 ? issueEnd : issueEnd + space;
    }

    return [start, end];
}

function Issue({ text, match, choice, onChoose }: { text: string; match: GrammarMatch; choice: string | null; onChoose(value: string | null): void; }) {
    const { message, offset, length } = match;
    const [start, end] = contextBounds(text, offset, length);

    return (
        <div className={cl("issue")}>
            {message && <Paragraph className={cl("message")}>{message}</Paragraph>}
            <Paragraph>
                {start > 0 && "..."}
                {text.slice(start, offset)}
                <span className={cl("error")}>{text.slice(offset, offset + length)}</span>
                {text.slice(offset + length, end)}
                {end < text.length && "..."}
            </Paragraph>
            <div className={cl("choices")}>
                {match.replacements.slice(0, 4).map(({ value }) => (
                    <Button key={value} size="min" variant={choice === value ? "primary" : "secondary"} onClick={() => onChoose(value)}>
                        {value || "(remove)"}
                    </Button>
                ))}
                <Button size="min" variant={choice === null ? "primary" : "secondary"} onClick={() => onChoose(null)}>
                    Ignore
                </Button>
            </div>
        </div>
    );
}

function FixModal({ channelId, text, ...props }: RenderModalProps & { channelId: string; text: string; }) {
    const [matches, error, pending] = useAwaiter(() => checkText(text), { fallbackValue: [] });
    const [choices, setChoices] = useState<Record<number, string | null>>({});

    const chosen = matches.map((match, i) => i in choices ? choices[i] : match.replacements[0]?.value ?? null);
    const fixedText = applyFixes(text, matches.flatMap<Fix>(({ offset, length }, i) => chosen[i] === null ? [] : [{ offset, length, value: chosen[i] }]));

    return (
        <Modal
            {...props}
            title="Fix Grammar"
            subtitle={pending ? "Checking..." : error ? String(error.message ?? error) : matches.length ? null : "No issues found."}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: props.onClose },
                {
                    text: "Apply",
                    variant: "primary",
                    disabled: fixedText === text,
                    onClick() {
                        setDraft(channelId, fixedText);
                        props.onClose();
                    }
                }
            ]}
        >
            {matches.map((match, i) => (
                <Issue
                    key={`${match.offset}-${match.length}`}
                    text={text}
                    match={match}
                    choice={chosen[i]}
                    onChoose={value => setChoices({ ...choices, [i]: value })}
                />
            ))}
        </Modal>
    );
}

export function openFixModal(channelId: string, text: string) {
    openModal(props => <FixModal {...props} channelId={channelId} text={text} />);
}
