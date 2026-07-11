import type { CondenseConfig } from "./config";
import type { CandidateManifestItem } from "./protocol";
import type { JsonRecord, TranscriptRow } from "./transcript";

export type TokenProjection = {
  model: string;
  method: "host" | "provider";
  scope: "full-context" | "messages";
  source: number;
  projected: number;
  removed: number;
};

export type SessionIdentity = {
  host: "claude-code" | "codex";
  sessionId: string;
  transcriptPath: string;
  projectCwd: string;
};

export type SessionSnapshot = {
  identity: SessionIdentity;
  cutoffUuid: string;
  operationUserUuid: string;
  storageEntries: JsonRecord[];
  contextEntries: TranscriptRow[];
  storageDigest: string;
  contextDigest: string;
};

export type ForkedSession = {
  sessionId: string;
  transcriptPath: string;
  storageEntries: JsonRecord[];
  messageRows: TranscriptRow[];
  oldToNew: Map<string, string>;
};

export type TokenCounter = {
  project(snapshot: SessionSnapshot, plan: PreparedRetentionPlan): Promise<TokenProjection>;
};

export type HostAdapter = {
  readonly host: SessionIdentity["host"];
  readonly tokenCounter?: TokenCounter;
  locateCurrentSession(): SessionIdentity;
  snapshot(identity: SessionIdentity, expectedCutoffUuid?: string): Promise<SessionSnapshot>;
  fork(snapshot: SessionSnapshot, title: string): Promise<ForkedSession>;
  cleanupFork(fork: Pick<ForkedSession, "transcriptPath">): Promise<void>;
};

export type DecisionInput = {
  keep: string[];
  drop: string[];
  title?: string;
};

export type PlannedOmission = {
  ref: string;
  contentId: string;
};

export type PreparedRetentionPlan = {
  config: CondenseConfig;
  candidates: CandidateManifestItem[];
  decision: DecisionInput;
  omissions: PlannedOmission[];
  projectedChars: number;
};
