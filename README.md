<div align="center">

<img src="assets/icon.svg" width="96" height="96" alt="Grammar Fixer icon">

# Grammar Fixer for Vencord

Fix the grammar of your Discord messages and get reply suggestions, with LanguageTool, any AI provider, or the AI subscription you already pay for.

[![Vencord userplugin](https://img.shields.io/badge/Vencord-userplugin-5865F2?logo=discord&logoColor=white)](https://vencord.dev)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Desktop only](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#install)
[![240+ providers](https://img.shields.io/badge/providers-240%2B-success)](#providers)

[GitHub](https://github.com/ve3dy/vencord-grammar-fixer) · [GitLab](https://gitlab.com/ve3dy/vencord-grammar-fixer)

</div>

> [!NOTE]
> Unofficial. Not affiliated with or endorsed by Vencord or Discord. Userplugins need a [source build of Vencord](https://docs.vencord.dev/installing/).

## Features

<img src="assets/chatbar.png" alt="Fix Grammar button in the chat bar" width="100%">

- **Fix Grammar**: one click on the chat bar button checks your draft. Every change is listed on its own, so you keep the ones you like and ignore the rest.
- **Suggest Reply**: right-click a message, or use its hover menu, and get a reply written for you. If you already started one, it polishes your draft instead.
- **Writing styles**: Minimal changes, Casual, Concise or Formal.
- **Safe for Discord markup**: mentions, emojis, links, markdown and code stay exactly as they are.
- **Fast**: about a second per check with small models, and thinking is turned off where the model allows it.

<table>
  <tr>
    <td width="50%"><img src="assets/fix.png" alt="Fix Grammar review"></td>
    <td width="50%"><img src="assets/reply.png" alt="Suggest Reply"></td>
  </tr>
  <tr>
    <td align="center">Review each fix before applying it</td>
    <td align="center">Reply suggestions</td>
  </tr>
</table>

## Providers

<img src="assets/settings.png" alt="Grammar Fixer settings" align="right" width="45%">

Pick a provider and a model in the plugin settings.

- **LanguageTool**: free, no account needed. Good at spelling and capitalization, weaker at grammar.
- **API key providers**: every provider on [models.dev](https://models.dev), over 220 of them, including OpenAI, Anthropic, Google, DeepSeek, OpenRouter, OpenCode, Groq, Mistral and xAI. The list and its models update daily.
- **Custom**: any OpenAI-compatible server, including local ones like Ollama or LM Studio.
- **Subscription sign in**: use a plan you already have instead of an API key (see below).

Each provider starts with its cheapest suitable model. You can pick another one, or choose "Other model id..." to type any model the provider supports.

<br clear="right">

### Subscription sign in

| Subscription | How you sign in | Tested with a real account |
|---|---|---|
| Claude Pro/Max | Browser | Yes |
| ChatGPT Plus/Pro (Codex) | Browser, or a device code if the port is busy | Yes |
| GitHub Copilot | Device code | Not yet |
| Gemini CLI (Google account) | Browser | Not yet |
| Google Antigravity | Browser | Not yet |
| xAI Grok | Device code | Not yet |
| Kimi Code | Device code | Not yet |
| Z.ai GLM Coding Plan | Browser, then paste the link it shows | Not yet |
| Qwen Portal | Paste a token (Qwen ended its free sign in in April 2026) | Not yet |
| Cursor | Browser | Not yet |
| Factory Droid | Device code | Not yet |
| Kilo | Device code | Not yet |
| Perplexity Pro/Max | Email code | Not yet |
| Muse Code (Meta) | Device code | Not yet |
| GitLab Duo | Browser | Not yet |
| Snowflake Cortex | Browser, with your account URL | Not yet |

> [!WARNING]
> These sign ins use the same flows as other coding tools, like opencode and oh-my-pi. Some providers don't allow third-party apps to use their subscriptions. **Anthropic's terms forbid it for Claude Pro/Max, and accounts have been banned for it.** Use subscription sign in at your own risk. API keys don't have this problem.

## Privacy and security

- Text is only sent when you click **Fix Grammar** or **Suggest Reply**. Nothing is checked or sent automatically.
- Requests run in Discord's main process, not in the Discord page.
- API keys and sign ins are stored in Vencord's `native-settings.json`, encrypted with your system keyring. They are never written to `settings.json`, so Vencord Cloud doesn't sync them. Without a keyring they are stored unencrypted.
- Keys can't be sent anywhere else: built-in providers always use their own address, and keys for custom servers are tied to the URL you saved them with.
- Settings only show which account you are signed in with. Keys and tokens are never shown again after you save them.

## Install

### Windows

```powershell
git clone https://github.com/ve3dy/vencord-grammar-fixer.git
cd vencord-grammar-fixer
powershell -ExecutionPolicy Bypass -File .\install.ps1 -VencordPath "C:\path\to\Vencord"
```

### macOS and Linux

```bash
git clone https://github.com/ve3dy/vencord-grammar-fixer.git
cd vencord-grammar-fixer
./install.sh /path/to/Vencord
```

The scripts copy the plugin to `src/userplugins/grammarFixer` and build Vencord. Use `-SkipBuild` or `--skip-build` to only copy, or set `VENCORD_DIR` instead of passing the path.

### Manual

From the root of your Vencord checkout:

```bash
git clone https://github.com/ve3dy/vencord-grammar-fixer.git src/userplugins/grammarFixer
pnpm build
```

Then:

1. Fully quit Discord (from the tray too) and open it again. Ctrl+R isn't enough, because part of the plugin runs in Discord's main process.
2. Enable **GrammarFixer** in Vencord's plugin settings.
3. Pick a provider in its settings.

### Update

Run `git pull` in your clone, run the installer again (or `pnpm build` for a manual install), then fully restart Discord.

Coming from an older version? Your saved API key moves into the encrypted store by itself the first time the plugin starts.

## Troubleshooting

| Problem | Fix |
|---|---|
| The Fix Grammar button is missing | It only shows when the message box has text. Make sure the plugin is enabled and Discord was fully restarted. |
| "Sign in to ... first" | Open the plugin settings and sign in again. Some providers end sessions after a while. |
| "The API URL changed" | You edited the API URL after saving the key. Paste the key again so it's tied to the new URL. |
| A model returns 404 or "not found" | The provider retired it. Pick another model in the settings. |
| Sign in never finishes | Use the link shown in the settings, or paste the final URL or code when it asks. |

## Development

Validated in a Vencord checkout with:

```bash
pnpm test:ts
pnpm lint
pnpm build
```

## Credits

- Subscription sign in flows are ported from [oh-my-pi](https://github.com/can1357/oh-my-pi).
- Provider and model list from [models.dev](https://models.dev).
- Free checks by [LanguageTool](https://languagetool.org).

## License

[GPL-3.0-or-later](LICENSE), like Vencord.
