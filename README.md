# Highlight Inbox Synthesizer

An Obsidian plugin that turns a folder of saved highlights into one synthesis note: a summary and the key claims for each source, plus the themes that run across multiple sources.

## The Problem

People export highlights from Readwise, Snipd, or Kindle into their vault and rarely open them again. The saved passages pile up in a folder and turn into a graveyard that nobody revisits. This plugin reads the whole folder and writes one synthesis note: what each source said, and which ideas show up across more than one source, so the backlog becomes something you can use.

It works with any highlight export that lands in a folder or carries a tag. Readwise is the common case and the default, but Snipd, Kindle exports, or notes you write by hand are read the same way.

## Features

- Source summaries: each source's highlights condensed into a short summary, its key claims, and a topic list
- Cross-source themes: topics shared by two or more sources, with a consensus written by the model and any real tension between sources
- One synthesis note written to your vault root and opened for you
- Incremental sync: unchanged sources are skipped, so re-running costs nothing for what has not changed
- Flexible parsing: callout highlights, block-id highlights, bullet lists, and plain notes are all read

## How It Works

1. Get your highlights into the vault (Readwise official sync, another export tool, or by hand)
2. Run **Sync highlights** from the command palette to extract a summary, key claims, and topics for each source
3. Run **Generate highlights report** from the command palette or the ribbon icon
4. A `Highlight Inbox Synthesis.md` note is written to your vault root and opened
5. Re-run either command any time. Syncing is incremental, so unchanged sources are never re-processed

## Setup

1. Install the plugin from Obsidian Community Plugins
2. Go to **Settings → Highlight Inbox Synthesizer**
3. Select your AI provider (Anthropic, OpenAI, OpenRouter, or custom)
4. Enter your API key
5. Set your source folder (default `Readwise/`) or source tag (default `readwise`)
6. Run **Sync highlights**, then **Generate highlights report**

## Supported AI Providers

- **Anthropic**: Claude models (recommended: `claude-sonnet-4-6`)
- **OpenAI**: GPT models (recommended: `gpt-4o-mini`)
- **OpenRouter**: access to many models including free options (recommended: `meta-llama/llama-4-maverick`)
- **Custom**: any OpenAI-compatible endpoint

## Free vs Pro

| Feature | Free | Pro |
|---|---|---|
| Highlight syncs | 3 total (lifetime) | Unlimited |
| Synthesis report | Unlimited | Unlimited |
| All AI providers | Yes | Yes |
| Cross-source themes | Yes | Yes |

The free tier allows 3 total syncs. This is a one-time lifetime allowance, not a monthly reset. Generating the report from already-synced highlights is always free. Pro is a one-time license that removes the sync limit. Get it here: https://ibrh96.gumroad.com/l/vtqocc

## Privacy

- The plugin has no server, no account, and no backend. Nothing about your use is collected on the developer's side.
- Your API key is stored locally in Obsidian's plugin data on your device.
- The plugin uses your own API key (BYOK). When you sync, the text of your highlights is sent to the AI provider you configure (Anthropic, OpenAI, OpenRouter, or your custom endpoint) so it can be summarized. That content goes to your chosen provider under their terms and is not sent anywhere else.

To be clear, this is not an on-device-only tool. Synthesis requires sending your highlight text to an external model provider that you choose. If a particular source is too sensitive to send to that provider, keep it out of the configured folder or tag.

## License

See [EULA.md](EULA.md) for the terms of use.
