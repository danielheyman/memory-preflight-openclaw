# Memory Preflight Plugin for OpenClaw

Automatically searches workspace memory files before each agent turn and injects relevant context.

## Features

- **Auto-recall**: Searches memory files based on user query entities
- **LLM entity extraction**: Uses local Ollama (gemma3:4b) to extract key entities from queries
- **Smart ranking**: Combines vector similarity with file freshness
- **Configurable**: Adjustable result limits and memory directories

## Installation

1. Clone this repo into your OpenClaw extensions directory:
   ```bash
   cd ~/.openclaw/extensions
   git clone https://github.com/dbitt/memory-preflight.git
   ```

2. Restart OpenClaw gateway

## Requirements

- OpenClaw with plugin support
- (Optional) Ollama running locally for LLM-based entity extraction
  - Recommended model: `gemma3:4b`
  - Falls back to stop-word filtering if Ollama unavailable

## How It Works

1. Hooks into `before_agent_start` event
2. Extracts entities from user's message using local LLM
3. Searches memory files using OpenClaw's memory search tool
4. Injects relevant snippets as `memory-hints` context

## Configuration

Edit `openclaw.plugin.json` to customize behavior.

## License

MIT
