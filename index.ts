/**
 * Memory Preflight Plugin
 *
 * Auto-recalls from existing MEMORY.md and memory/*.md files
 * before each agent turn. Uses OpenClaw's built-in memory search tool.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

type MemoryResult = {
  path: string;
  snippet: string;
  score: number;
  from?: number;
  to?: number;
};

// LLM-based entity extraction via Ollama
async function extractEntities(query: string): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma3:4b",
        prompt: `Extract only the key names/entities from this question. Return comma-separated, nothing else.\nQuestion: ${query}\nEntities:`,
        stream: false,
        options: { num_predict: 30, temperature: 0 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const entities = data.response?.trim();
    if (entities && entities.length > 0 && entities.length < 200) {
      return entities;
    }
    return null;
  } catch {
    return null;
  }
}

const memoryPreflightPlugin = {
  id: "memory-preflight",
  name: "Memory Preflight",
  description: "Auto-recall from workspace memory files before each response",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    let memoryTool: ReturnType<typeof api.runtime.tools.createMemorySearchTool> | null = null;

    console.log("[memory-preflight] plugin registering, about to add before_agent_start hook");
    api.logger.info("memory-preflight: plugin registered");

    // Auto-recall: search memory before agent starts
    api.on("before_agent_start", async (event) => {
      console.log(`[memory-preflight] HOOK FIRED! prompt length: ${event.prompt?.length ?? 0}`);
      api.logger.info(`memory-preflight: before_agent_start fired, prompt length: ${event.prompt?.length ?? 0}`);
      
      const rawPrompt = event.prompt;

      // Skip if no prompt or too short
      if (!rawPrompt || rawPrompt.length < 10) {
        console.log("[memory-preflight] skipping - prompt too short");
        return;
      }

      // Extract just the user message, stripping metadata noise
      // Format: "[Day YYYY-MM-DD HH:MM TZ] message\n[message_id: uuid]"
      // Also handles: "System: [...]\n\n[Day ...] message" patterns
      let prompt = rawPrompt;
      
      // Remove [message_id: ...] suffix
      prompt = prompt.replace(/\n?\[message_id:\s*[^\]]+\]/g, "");
      
      // Remove timestamp prefix: [Day YYYY-MM-DD HH:MM TZ]
      prompt = prompt.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]+\]\s*/gm, "");
      
      // Remove System: messages (GatewayRestart, WhatsApp connected, etc.)
      // Single-line: System: [timestamp] message
      prompt = prompt.replace(/^System:\s*\[.*?\].*$/gm, "");
      // Multi-line JSON: System: [timestamp] {\n...\n}
      prompt = prompt.replace(/System:\s*\[[^\]]*\]\s*\{[\s\S]*?\n\}/g, "");
      // Bare System: with JSON
      prompt = prompt.replace(/System:\s*\{[\s\S]*?\n\}/g, "");
      
      // Clean up extra whitespace
      prompt = prompt.trim();

      // Try LLM-based entity extraction first (gemma3:4b via Ollama)
      let searchQuery: string;
      const llmEntities = await extractEntities(prompt);
      
      if (llmEntities) {
        // Use LLM-extracted entities
        searchQuery = llmEntities.toLowerCase().replace(/,/g, " ");
        console.log(`[memory-preflight] LLM entities: "${llmEntities}" → "${searchQuery}"`);
      } else {
        // Fallback: Extract keywords by removing stop words
        const stopWords = new Set([
          // Question words
          "what", "who", "where", "when", "why", "how", "which",
          // Be verbs
          "is", "are", "was", "were", "be", "been", "being",
          // Articles/determiners
          "the", "a", "an", "this", "that", "these", "those",
          // Pronouns
          "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
          "my", "your", "his", "its", "our", "their",
          // Auxiliary verbs
          "do", "does", "did", "have", "has", "had", "can", "could", "will", "would", "should",
          // Prepositions
          "about", "with", "from", "into", "of", "for", "on", "at", "to", "by",
          // Conjunctions
          "and", "or", "but", "if", "then", "so", "because",
          // Common verbs
          "tell", "know", "think", "see", "say", "talk", "look", "find", "get", "give",
          // Adverbs
          "just", "also", "very", "really", "now", "here", "there",
          // Meta-words about the system (asking about memories/hints)
          "hints", "hint", "seeing", "showing", "show", "recall", "remember", "remembered",
          "memory", "memories", "file", "files", "context", "relevant", "related",
        ]);
        searchQuery = prompt
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1 && !stopWords.has(w.replace(/[?.,!]/g, "")))
          .join(" ");
        console.log(`[memory-preflight] stopword fallback: "${searchQuery}"`);
      }
      
      console.log(`[memory-preflight] cleaned: "${prompt.slice(0, 60)}..." → query: "${searchQuery}"`);

      // Skip if cleaned prompt is too short
      if (prompt.length < 3) {
        console.log("[memory-preflight] skipping - cleaned prompt too short");
        return;
      }

      // Skip slash commands
      if (prompt.startsWith("/")) {
        console.log("[memory-preflight] skipping - slash command");
        return;
      }

      // Skip common short responses that don't need context
      const skipPatterns = [
        /^(ok|okay|sure|thanks|thank you|yes|no|yep|nope|got it|sounds good)\.?$/i,
        /^(hi|hello|hey|morning|evening)\.?$/i,
      ];
      if (skipPatterns.some((p) => p.test(prompt))) {
        console.log("[memory-preflight] skipping - matches skip pattern");
        return;
      }

      try {
        console.log("[memory-preflight] creating memory tool...");
        // Create or reuse the memory search tool
        if (!memoryTool) {
          memoryTool = api.runtime.tools.createMemorySearchTool({
            config: api.config,
            agentSessionKey: event.sessionKey,
          });
          console.log(`[memory-preflight] memoryTool created: ${memoryTool ? 'yes' : 'null'}`);
        }

        if (!memoryTool) {
          console.log("[memory-preflight] memory search not configured, skipping");
          return;
        }

        // Skip if no meaningful keywords after filtering
        if (searchQuery.length < 3) {
          console.log("[memory-preflight] skipping - no meaningful keywords after filtering");
          return;
        }

        console.log(`[memory-preflight] executing search for: "${searchQuery}"`);
        // Execute the search
        const result = await memoryTool.execute("preflight", {
          query: searchQuery,
          maxResults: 5,
          minScore: 0.3,
        });
        console.log(`[memory-preflight] search result: ${JSON.stringify(result).slice(0, 200)}`);

        // Parse results from tool response
        const content = result?.content?.[0];
        if (!content || content.type !== "text") {
          console.log("[memory-preflight] no text content in result");
          return;
        }

        // The tool returns JSON - parse it
        let parsed: { results?: MemoryResult[]; disabled?: boolean };
        try {
          parsed = JSON.parse(content.text);
        } catch {
          console.log("[memory-preflight] failed to parse tool response");
          return;
        }

        if (parsed.disabled || !parsed.results || parsed.results.length === 0) {
          console.log(`[memory-preflight] no relevant memories (disabled: ${parsed.disabled}, results: ${parsed.results?.length ?? 0})`);
          return;
        }

        const results = parsed.results;

        // Format as lightweight hints with match preview
        const hints = results
          .map((r) => {
            const relativePath = r.path.replace(/^.*\.openclaw\/workspace\//, "");
            // Extract first ~80 chars of snippet as preview, clean up whitespace
            const preview = r.snippet
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80)
              .trim();
            return `- ${relativePath} (${r.score.toFixed(2)}): "${preview}..."`;
          })
          .join("\n");

        console.log(`[memory-preflight] hinting ${results.length} files (scores: ${results.map((r) => r.score.toFixed(2)).join(", ")})`);
        api.logger.info(`memory-preflight: hinting ${results.length} files`);

        return {
          prependContext: `<memory-hints>
Possibly relevant (read if needed):
${hints}
</memory-hints>`,
        };
      } catch (err) {
        console.log(`[memory-preflight] ERROR: ${String(err)}`);
        api.logger.warn(`memory-preflight: search failed: ${String(err)}`);
      }
    });

    api.registerService({
      id: "memory-preflight",
      start: () => {
        console.log("[memory-preflight] service started");
        api.logger.info("memory-preflight: active");
      },
      stop: () => {
        console.log("[memory-preflight] service stopped");
        api.logger.info("memory-preflight: stopped");
      },
    });
  },
};

export default memoryPreflightPlugin;
