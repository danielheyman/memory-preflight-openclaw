/**
 * Memory Preflight Plugin
 *
 * Auto-recalls from existing memory/*.md files before each agent turn.
 * Uses Ollama for entity extraction + QMD for fast local BM25 search.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { exec } from "child_process";
import { promisify } from "util";
import { appendFile } from "fs/promises";

const execAsync = promisify(exec);

// Paths
const QMD_PATH = `${process.env.HOME}/.bun/bin/qmd`;
const LOG_PATH = `${process.env.HOME}/.openclaw/workspace/memory/meta/search-log.jsonl`;

type QmdResult = {
  hash: string;
  score: number;
  path: string;
};

type SearchLog = {
  ts: string;
  prompt: string;
  entities: string | null;
  searchQuery: string;
  results: { path: string; score: number }[];
  extractMs: number;
  searchMs: number;
  totalMs: number;
};

// Log search for later analysis
async function logSearch(entry: SearchLog): Promise<void> {
  try {
    await appendFile(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.log(`[memory-preflight] Failed to log search: ${err}`);
  }
}

// LLM-based entity extraction via Ollama - with synonym expansion for BM25
async function extractEntities(query: string): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma3:4b",
        prompt: `Extract 2-4 key search terms (nouns, names, topics). Output ONLY comma-separated terms.

"my girlfriend's birthday" → girlfriend, birthday
"what supplements should I take" → supplements, health
"tell me about the Toronto trip" → Toronto, trip
"what did we discuss yesterday" → yesterday, discussion

"${query}" →`,
        stream: false,
        options: { num_predict: 60, temperature: 0 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const entities = data.response?.trim();
    if (entities && entities.length > 0 && entities.length < 300) {
      return entities;
    }
    return null;
  } catch (err) {
    console.log(`[memory-preflight] Ollama fetch error: ${err}`);
    return null;
  }
}

// Search memory using QMD BM25
async function searchWithQmd(query: string, maxResults: number = 5): Promise<QmdResult[]> {
  try {
    // Use --files format: hash,score,path
    const { stdout } = await execAsync(
      `${QMD_PATH} search "${query.replace(/"/g, '\\"')}" -n ${maxResults} --files 2>/dev/null`,
      { timeout: 5000 }
    );
    
    if (!stdout.trim()) return [];
    
    // Parse CSV-like output: #hash,score,qmd://collection/path
    const results: QmdResult[] = [];
    for (const line of stdout.trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length >= 3) {
        const hash = parts[0];
        const score = parseFloat(parts[1]);
        // Convert qmd://memory/path to workspace path
        const qmdPath = parts.slice(2).join(","); // handle paths with commas
        const relativePath = qmdPath.replace(/^qmd:\/\/memory\//, "memory/");
        results.push({ hash, score, path: relativePath });
      }
    }
    return results;
  } catch (err) {
    console.log(`[memory-preflight] QMD search error: ${err}`);
    return [];
  }
}

// Get snippet from file at approximate location
async function getSnippet(path: string, maxChars: number = 100): Promise<string> {
  try {
    const fullPath = `${process.env.HOME}/.openclaw/workspace/${path}`;
    const { stdout } = await execAsync(`head -c 500 "${fullPath}" 2>/dev/null`);
    // Clean up and truncate
    const cleaned = stdout.replace(/^#.*\n/, "").replace(/\s+/g, " ").trim();
    return cleaned.slice(0, maxChars);
  } catch {
    return "";
  }
}

const memoryPreflightPlugin = {
  id: "memory-preflight",
  name: "Memory Preflight (Hybrid)",
  description: "Auto-recall: QMD (fast/local) with Gemini fallback (semantic)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    let memoryTool: ReturnType<typeof api.runtime.tools.createMemorySearchTool> | null = null;
    
    console.log("[memory-preflight] plugin registering with hybrid backend (QMD + Gemini fallback)");
    api.logger.info("memory-preflight: plugin registered (hybrid)");

    // Auto-recall: search memory before agent starts
    api.on("before_agent_start", async (event) => {
      const startTotal = Date.now();
      console.log(`[memory-preflight] HOOK FIRED! prompt length: ${event.prompt?.length ?? 0}`);
      
      const rawPrompt = event.prompt;

      // Skip if no prompt or too short
      if (!rawPrompt || rawPrompt.length < 10) {
        console.log("[memory-preflight] skipping - prompt too short");
        return;
      }

      // Extract just the user message, stripping metadata noise
      let prompt = rawPrompt;
      
      // Remove [message_id: ...] suffix
      prompt = prompt.replace(/\n?\[message_id:\s*[^\]]+\]/g, "");
      
      // Remove timestamp prefix: [Day YYYY-MM-DD HH:MM TZ]
      prompt = prompt.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]+\]\s*/gm, "");
      
      // Remove System: messages
      prompt = prompt.replace(/^System:\s*\[.*?\].*$/gm, "");
      prompt = prompt.replace(/System:\s*\[[^\]]*\]\s*\{[\s\S]*?\n\}/g, "");
      prompt = prompt.replace(/System:\s*\{[\s\S]*?\n\}/g, "");
      
      // Clean up extra whitespace
      prompt = prompt.trim();

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

      // Extract entities via Ollama (with synonyms)
      const startExtract = Date.now();
      const llmEntities = await extractEntities(prompt);
      const extractMs = Date.now() - startExtract;
      
      if (!llmEntities) {
        console.log("[memory-preflight] Ollama not available, skipping memory search");
        return {
          prependContext: `<memory-hints>
⚠️ Local LLM (Ollama) not running. Memory search disabled.
Run \`ollama serve\` and ensure gemma3:4b is available.
</memory-hints>`,
        };
      }
      
      // Use LLM-extracted entities for search - limit to 3 terms to avoid BM25 dilution
      const allTerms = llmEntities.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ");
      const searchTerms = allTerms.slice(0, 3);
      const searchQuery = searchTerms.join(" ");
      console.log(`[memory-preflight] entities (${extractMs}ms): "${llmEntities}" → [${allTerms.length} terms] → "${searchQuery}"`);

      // Skip if no meaningful search query
      if (searchQuery.length < 2) {
        console.log("[memory-preflight] skipping - no meaningful search query");
        return;
      }

      try {
        // Search with QMD
        const startSearch = Date.now();
        const results = await searchWithQmd(searchQuery, 5);
        const searchMs = Date.now() - startSearch;
        const totalMs = Date.now() - startTotal;
        
        console.log(`[memory-preflight] QMD search (${searchMs}ms): ${results.length} results, total: ${totalMs}ms`);

        // Log for analysis
        await logSearch({
          ts: new Date().toISOString(),
          prompt: prompt.slice(0, 200),
          entities: llmEntities,
          searchQuery,
          results: results.map(r => ({ path: r.path, score: r.score })),
          extractMs,
          searchMs,
          totalMs,
        });

        if (results.length === 0) {
          // QMD found nothing - fall back to Gemini for semantic search
          console.log("[memory-preflight] QMD: 0 results, falling back to Gemini...");
          
          try {
            if (!memoryTool) {
              memoryTool = api.runtime.tools.createMemorySearchTool({
                config: api.config,
                agentSessionKey: event.sessionKey,
              });
            }
            
            if (!memoryTool) {
              console.log("[memory-preflight] Gemini fallback not configured");
              return;
            }
            
            const startGemini = Date.now();
            const geminiResult = await memoryTool.execute("preflight-fallback", {
              query: prompt.slice(0, 200), // Use original prompt for semantic search
              maxResults: 5,
              minScore: 0.3,
            });
            const geminiMs = Date.now() - startGemini;
            
            const content = geminiResult?.content?.[0];
            if (!content || content.type !== "text") {
              console.log("[memory-preflight] Gemini fallback: no results");
              return;
            }
            
            let parsed: { results?: Array<{path: string; snippet: string; score: number}>; disabled?: boolean };
            try {
              parsed = JSON.parse(content.text);
            } catch {
              console.log("[memory-preflight] Gemini fallback: parse error");
              return;
            }
            
            if (parsed.disabled || !parsed.results || parsed.results.length === 0) {
              console.log("[memory-preflight] Gemini fallback: no matches");
              return;
            }
            
            const geminiHints = parsed.results.map((r) => {
              const relativePath = r.path.replace(/^.*\.openclaw\/workspace\//, "");
              const preview = r.snippet.replace(/\s+/g, " ").trim().slice(0, 80);
              return `- ${relativePath} (${r.score.toFixed(2)}): "${preview}..."`;
            });
            
            console.log(`[memory-preflight] Gemini fallback (${geminiMs}ms): ${parsed.results.length} results`);
            
            // Log fallback usage
            await logSearch({
              ts: new Date().toISOString(),
              prompt: prompt.slice(0, 200),
              entities: llmEntities,
              searchQuery: searchQuery + " [GEMINI FALLBACK]",
              results: parsed.results.map(r => ({ 
                path: r.path.replace(/^.*\.openclaw\/workspace\//, ""), 
                score: r.score 
              })),
              extractMs,
              searchMs: geminiMs,
              totalMs: Date.now() - startTotal,
            });
            
            return {
              prependContext: `<memory-hints>
Possibly relevant (read if needed):
${geminiHints.join("\n")}
</memory-hints>`,
            };
          } catch (err) {
            console.log(`[memory-preflight] Gemini fallback error: ${err}`);
            return;
          }
        }

        // Get snippets for each result
        const hintsWithSnippets = await Promise.all(
          results.map(async (r) => {
            const snippet = await getSnippet(r.path);
            return `- ${r.path} (${r.score.toFixed(2)}): "${snippet}..."`;
          })
        );

        console.log(`[memory-preflight] hinting ${results.length} files in ${totalMs}ms`);
        api.logger.info(`memory-preflight: ${results.length} hints in ${totalMs}ms`);

        return {
          prependContext: `<memory-hints>
Possibly relevant (read if needed):
${hintsWithSnippets.join("\n")}
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
        console.log("[memory-preflight] service started (QMD backend)");
        api.logger.info("memory-preflight: active (QMD)");
      },
      stop: () => {
        console.log("[memory-preflight] service stopped");
        api.logger.info("memory-preflight: stopped");
      },
    });
  },
};

export default memoryPreflightPlugin;
