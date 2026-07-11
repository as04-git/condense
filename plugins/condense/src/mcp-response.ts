import type { CondenseConfig } from "./config";

export function configForMcpResponse(config: CondenseConfig): CondenseConfig {
  const responseLimit = config.retrieval.maxResponseChars;
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      // The JSON text is escaped once more by the MCP envelope. Half the
      // configured budget is a deterministic upper bound for that expansion.
      maxResponseChars: Math.max(256, Math.floor((responseLimit - 256) / 2)),
    },
  };
}

export function boundedMcpTextResponse(result: unknown, responseLimit: number) {
  const response = { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  if (JSON.stringify(response).length > responseLimit)
    throw new Error("Bounded retrieval result exceeded retrieval.maxResponseChars after MCP serialization");
  return response;
}
