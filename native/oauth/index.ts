/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { anthropic } from "./anthropic";
import { cursor } from "./cursor";
import { factoryDroid } from "./factoryDroid";
import { githubCopilot } from "./githubCopilot";
import { gitlabDuo } from "./gitlabDuo";
import { googleAntigravity } from "./googleAntigravity";
import { googleGeminiCli } from "./googleGeminiCli";
import { kilo } from "./kilo";
import { kimiCode } from "./kimiCode";
import { museCode } from "./museCode";
import { openaiCodex } from "./openaiCodex";
import { perplexity } from "./perplexity";
import { qwenPortal } from "./qwenPortal";
import { snowflake } from "./snowflake";
import type { OAuthProvider } from "./types";
import { xaiOAuth } from "./xaiOAuth";
import { zai } from "./zai";

export const oauthProviders: OAuthProvider[] = [
    anthropic,
    openaiCodex,
    githubCopilot,
    googleGeminiCli,
    googleAntigravity,
    xaiOAuth,
    kimiCode,
    zai,
    qwenPortal,
    cursor,
    factoryDroid,
    kilo,
    perplexity,
    museCode,
    gitlabDuo,
    snowflake
];
