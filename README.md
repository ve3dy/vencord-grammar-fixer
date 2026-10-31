<div align="center">

<img src="assets/icon.svg" width="96" height="96" alt="Grammar Fixer icon">

# Grammar Fixer for Vencord

Fix the grammar of your Discord messages and get reply suggestions.

[![Vencord userplugin](https://img.shields.io/badge/Vencord-userplugin-5865F2?logo=discord&logoColor=white)](https://vencord.dev)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

<img src="assets/chatbar.png" alt="Fix Grammar button in the chat bar" width="100%">

</div>

## Features

- **Fix Grammar**: click the button in the chat bar to check your message. Every fix is listed on its own, so you can keep or ignore each one.
- **Suggest Reply**: right-click a message to get a reply written for you.
- **Writing styles**: Minimal changes, Casual, Concise or Formal.
- Mentions, emojis, links and code are left alone.

<table>
  <tr>
    <td width="50%"><img src="assets/fix.png" alt="Fix Grammar"></td>
    <td width="50%"><img src="assets/reply.png" alt="Suggest Reply"></td>
  </tr>
</table>

## Providers

<img src="assets/settings.png" alt="Settings" align="right" width="42%">

- **LanguageTool**: free, no account needed.
- **Any API key provider**: 220+ from [models.dev](https://models.dev), like OpenAI, Anthropic, Google, DeepSeek and OpenRouter.
- **Custom**: any OpenAI-compatible server, including local ones like Ollama.
- **Subscription sign in**: Claude, ChatGPT, GitHub Copilot, Gemini and more.

Keys and sign ins are stored encrypted outside Discord. Text is only sent when you click a button.

<br clear="right">

## Install

Needs a [source build of Vencord](https://docs.vencord.dev/installing/). From your Vencord folder:

```bash
git clone https://github.com/ve3dy/vencord-grammar-fixer.git src/userplugins/grammarFixer
pnpm build
```

Then fully quit Discord (Ctrl+R isn't enough), open it again, and enable **GrammarFixer** in Vencord's plugin settings.

To update, run `git pull` in `src/userplugins/grammarFixer`, then `pnpm build` and restart Discord.

Prefer a script? From a clone of this repo, run `./install.sh /path/to/Vencord` on macOS or Linux, or `.\install.ps1 -VencordPath C:\path\to\Vencord` on Windows.

## License

[GPL-3.0-or-later](LICENSE). Not affiliated with Vencord or Discord.

Sign in flows are ported from [oh-my-pi](https://github.com/can1357/oh-my-pi), the provider list comes from [models.dev](https://models.dev), and free checks are by [LanguageTool](https://languagetool.org).
