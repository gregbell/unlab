// WebMCP: the lab's verbs as tools for an agent in the same browser. main.ts
// starts it once; the agent panel reads its calls from the store and answers
// waiting ones through `answer`.

export { type Agent, type AgentDeps, DENIED, type OfferedTool, startAgent, type ToolRow } from "./agent.ts";
export type { SessionScreens } from "./tools.ts";
export { detectModelContext, type ModelContextLike, type WebMcpTool } from "./webmcp.ts";
