import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config";
import { boundedMcpTextResponse, configForMcpResponse } from "./mcp-response";
import { readOmittedContent, searchOmittedContent } from "./omission";

const server = new Server({ name: "condense", version: "0.3.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "read_omitted_content",
      description:
        "Read a bounded exact-value rendering from one Content-ID. Bare reads return the first configured page with continuation metadata; use start/length to page.",
      inputSchema: {
        type: "object",
        properties: {
          contentId: { type: "string", description: "Content-ID shown by a condense placeholder." },
          start: { type: "integer", minimum: 0, description: "Optional zero-based rendered character offset." },
          length: { type: "integer", minimum: 1, description: "Optional number of rendered characters to return." },
        },
        required: ["contentId"],
        additionalProperties: false,
      },
    },
    {
      name: "search_omitted_content",
      description:
        "Search omitted content with bounded context. Defaults to literal search across the current condensed session lineage; mode=regex uses the safe RE2 subset. Explicit contentIds replace lineage scope.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["literal", "regex"], default: "literal" },
          contentIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional exact scope; omitted searches current lineage.",
          },
          caseSensitive: { type: "boolean" },
          contextLines: { type: "integer", minimum: 0 },
          maxMatches: { type: "integer", minimum: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  const cwd = process.env["CLAUDE_PROJECT_DIR"] || process.cwd();
  const config = await loadConfig(cwd);
  const responseLimit = config.retrieval.maxResponseChars;
  const boundedConfig = configForMcpResponse(config);
  let result: unknown;
  if (request.params.name === "read_omitted_content") {
    if (typeof args["contentId"] !== "string") throw new Error("read_omitted_content requires contentId");
    result = await readOmittedContent(args["contentId"], {
      start: typeof args["start"] === "number" ? args["start"] : undefined,
      length: typeof args["length"] === "number" ? args["length"] : undefined,
      config: boundedConfig,
    });
    if (!result) throw new Error(`No omitted content found for Content-ID ${args["contentId"]}`);
  } else if (request.params.name === "search_omitted_content") {
    if (typeof args["query"] !== "string") throw new Error("search_omitted_content requires query");
    if (args["mode"] !== undefined && args["mode"] !== "literal" && args["mode"] !== "regex")
      throw new Error("mode must be literal or regex");
    result = await searchOmittedContent({
      query: args["query"],
      mode: args["mode"] === "regex" ? "regex" : "literal",
      contentIds: Array.isArray(args["contentIds"]) ? (args["contentIds"] as string[]) : undefined,
      caseSensitive: typeof args["caseSensitive"] === "boolean" ? args["caseSensitive"] : undefined,
      contextLines: typeof args["contextLines"] === "number" ? args["contextLines"] : undefined,
      maxMatches: typeof args["maxMatches"] === "number" ? args["maxMatches"] : undefined,
      config: boundedConfig,
      sessionId: process.env["CLAUDE_CODE_SESSION_ID"],
    });
  } else throw new Error(`Tool ${request.params.name} not found`);
  return boundedMcpTextResponse(result, responseLimit);
});

await server.connect(new StdioServerTransport());
