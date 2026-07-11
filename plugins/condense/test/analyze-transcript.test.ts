import { expect, test } from "bun:test";
import { runAnalyze } from "../src/analyze";
import { DEFAULT_CONFIG } from "../src/config";
import {
  buildAssistantTurns,
  findCondenseOperationBoundary,
  validateCondenseSuffix,
  type TranscriptRow,
} from "../src/transcript";
import { assertForkLineage } from "../src/claude-adapter";

const row = (
  value: Partial<TranscriptRow> & Pick<TranscriptRow, "type" | "uuid" | "parentUuid" | "message">,
): TranscriptRow =>
  ({
    sessionId: "00000000-0000-0000-0000-000000000001",
    timestamp: new Date(Number(value.uuid.replace(/\D/g, "") || 1) * 1000).toISOString(),
    ...value,
  }) as TranscriptRow;

test("finds the current operation once and returns its preceding cutoff", () => {
  const rows = [
    row({ type: "user", uuid: "u1", parentUuid: null, message: { content: "real work" } }),
    row({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [{ type: "text", text: "done" }] } }),
    row({ type: "user", uuid: "op", parentUuid: "a1", message: { content: "/condense" } }),
    row({
      type: "user",
      uuid: "skill",
      parentUuid: "op",
      isMeta: true,
      message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/condense" }] },
    }),
    row({
      type: "assistant",
      uuid: "call",
      parentUuid: "skill",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool1",
            name: "Bash",
            input: { command: "bun /x/condense/src/condense.ts analyze" },
          },
        ],
      },
    }),
  ];
  expect(findCondenseOperationBoundary(rows)).toEqual({ operationUserUuid: "op", cutoffUuid: "a1" });
  expect(() =>
    validateCondenseSuffix(
      [...rows, row({ type: "user", uuid: "late", parentUuid: "call", message: { content: "new work" } })],
      "a1",
    ),
  ).toThrow("real user message");
});

test("condense markers never become semantic turns", () => {
  const rows = [
    row({ type: "user", uuid: "m", parentUuid: null, condenseMarker: true, message: { content: "🗜 CONDENSE" } }),
    row({ type: "assistant", uuid: "ma", parentUuid: "m", message: { content: [{ type: "text", text: "ack" }] } }),
    row({ type: "user", uuid: "u2", parentUuid: "ma", message: { content: "actual prompt" } }),
    row({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [{ type: "text", text: "answer" }] } }),
  ];
  const turns = buildAssistantTurns(rows);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.userRows[0]!.uuid).toBe("u2");
});

test("fails closed when the SDK omits fork lineage metadata", () => {
  expect(() =>
    assertForkLineage([row({ type: "user", uuid: "u", parentUuid: null, message: { content: "x" } })]),
  ).toThrow("forkedFrom.messageUuid");
});

test("large task notifications and errors are rankable with raw flags", () => {
  const task = `<task-notification><summary>Agent result</summary><result>${"x".repeat(1200)}</result></task-notification>`;
  const error = `fatal: ${"e".repeat(1100)}`;
  const rows = [
    row({ type: "user", uuid: "u1", parentUuid: null, message: { content: "delegate" } }),
    row({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        content: [
          { type: "tool_use", id: "agent1", name: "Agent", input: { prompt: "work" } },
          { type: "tool_use", id: "bash1", name: "Bash", input: { command: "test" } },
        ],
      },
    }),
    row({
      type: "user",
      uuid: "r1",
      parentUuid: "a1",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "agent1", content: task },
          { type: "tool_result", tool_use_id: "bash1", content: error, is_error: true },
        ],
      },
    }),
  ];
  const result = runAnalyze(rows, 0);
  const agent = result.rankableAttachments.find((item) => item.ref === "o:agent1")!;
  const failed = result.rankableAttachments.find((item) => item.ref === "o:bash1")!;
  expect(agent.kind).toBe("agent-result");
  expect(agent.action).toBe("drop");
  expect(agent.priority).toBeGreaterThan(0);
  expect(failed.signals).toContain("error");
  expect(failed.evidence).toContain("fatal");
});

test("Bash repeats are not newer-target signals while file reads are", () => {
  const huge = "z".repeat(1200);
  const rows = [
    row({ type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } }),
    row({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        content: [
          { type: "tool_use", id: "b1", name: "Bash", input: { command: "git status" } },
          { type: "tool_use", id: "f1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    }),
    row({
      type: "user",
      uuid: "r1",
      parentUuid: "a1",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "b1", content: huge },
          { type: "tool_result", tool_use_id: "f1", content: huge },
        ],
      },
    }),
    row({ type: "user", uuid: "u2", parentUuid: "r1", message: { content: "second" } }),
    row({
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      message: {
        content: [
          { type: "tool_use", id: "b2", name: "Bash", input: { command: "git status" } },
          { type: "tool_use", id: "f2", name: "Read", input: { file_path: "/x" } },
        ],
      },
    }),
    row({
      type: "user",
      uuid: "r2",
      parentUuid: "a2",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "b2", content: huge },
          { type: "tool_result", tool_use_id: "f2", content: huge },
        ],
      },
    }),
  ];
  const result = runAnalyze(rows, {
    ...DEFAULT_CONFIG,
    keepTurns: 0,
    policies: { ...DEFAULT_CONFIG.policies },
    retrieval: { ...DEFAULT_CONFIG.retrieval },
  });
  expect(result.rankableAttachments.find((item) => item.ref === "o:b1")!.newerOnSameTarget).toBe(false);
  expect(result.rankableAttachments.find((item) => item.ref === "o:f1")!.newerOnSameTarget).toBe(true);
  expect(result.rankableAttachments.every((item) => item.netChars > 0)).toBe(true);
});

test("thinking accounting includes reasoning text as well as its signature", () => {
  const rows = [
    row({ type: "user", uuid: "u1", parentUuid: null, message: { content: "reason" } }),
    row({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        content: [
          { type: "thinking", thinking: "x".repeat(10000), signature: "sig" },
          { type: "text", text: "done" },
        ],
      },
    }),
  ];
  const result = runAnalyze(rows, 0);
  expect(result.rankableThinking[0]!.size).toBeGreaterThan(10000);
  expect(result.rankableThinking[0]!.netChars).toBeGreaterThan(10000);
});
