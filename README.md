# Memory Preflight Plugin for OpenClaw

Auto-injects relevant memory context before each agent turn using a hybrid local/cloud approach.

## How It Works

```
User Query
    ↓
Ollama (gemma3:4b) extracts keywords (~400ms)
    ↓
QMD BM25 search (~350ms, local)
    ↓
Results found? → Inject hints ✓
    ↓
No results? → Gemini fallback (~250ms, semantic)
    ↓
Inject hints ✓
```

## Features

- **Fast local search** via QMD BM25 for keyword matches
- **Semantic fallback** via Gemini when BM25 finds nothing
- **Entity extraction** via Ollama (local LLM) 
- **Logging** to `memory/meta/search-log.jsonl` for analysis

## Performance

| Query Type | Path | Time |
|------------|------|------|
| Keyword match | Ollama → QMD | ~750ms |
| Semantic gap | Ollama → QMD → Gemini | ~1s |

## Requirements

- [Ollama](https://ollama.ai) running with `gemma3:4b` model
- [QMD](https://github.com/tobi/qmd) installed (`bun install -g github:tobi/qmd`)
- QMD collection set up: `qmd collection add /path/to/memory --name memory --mask "**/*.md"`
- OpenClaw with Gemini memorySearch configured (for fallback)

## Installation

1. Clone to OpenClaw extensions:
   ```bash
   git clone https://github.com/danielheyman/memory-preflight-openclaw ~/.openclaw/extensions/memory-preflight
   ```

2. Add to OpenClaw config (`~/.openclaw/openclaw.json`):
   ```json
   {
     "plugins": {
       "allow": ["memory-preflight"],
       "entries": {
         "memory-preflight": { "enabled": true }
       }
     }
   }
   ```

3. Set up QMD:
   ```bash
   qmd collection add ~/.openclaw/workspace/memory --name memory --mask "**/*.md"
   qmd embed
   ```

4. Restart OpenClaw gateway

## Configuration

The plugin uses these defaults:
- Ollama endpoint: `http://127.0.0.1:11434`
- Model: `gemma3:4b`
- QMD binary: `~/.bun/bin/qmd`
- Max results: 5
- Max search terms: 3

## License

MIT
