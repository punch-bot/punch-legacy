import type { ExtensionAPI } from "@punch-bot/cli";
import { Type } from "typebox";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://searxng:8080";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Web search",
    description: "Search the web using a self-hosted SearXNG instance",
    promptSnippet: "Search the web for information",
    promptGuidelines: [
      "Use websearch for current information or references.",
      "Batch independent search queries and other independent tools in the same assistant message. Wait for search results before fetching URLs discovered by that search.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, args) {
      const maxResults = args.maxResults || 5;
      const response = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(args.query)}&format=json`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}: ${await response.text()}`);
      const data = await response.json();
      const results = (data.results || []).slice(0, maxResults);
      const text = results.length
        ? results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}${r.content ? `\n   ${r.content}` : ""}`).join("\n\n")
        : `No results found for: ${args.query}`;
      return { content: [{ type: "text" as const, text }] };
    },
  });
}
