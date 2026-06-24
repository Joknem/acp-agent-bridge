export type QueueTaskMetadata = {
  id?: string;
  kind?: string;
  label?: string;
  summary?: string;
  owner?: string;
};

export type QueueTaskSnapshot = {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  owner?: string;
  enqueuedAt: number;
  startedAt?: number;
};

export type QueueStatusSnapshot = {
  active?: QueueTaskSnapshot;
  queued: number;
  pending: QueueTaskSnapshot[];
};

export function createQueueTask(sequence: number, metadata: QueueTaskMetadata = {}, now = Date.now()): QueueTaskSnapshot {
  return {
    id: metadata.id ?? `queue-${sequence}`,
    kind: metadata.kind ?? "task",
    label: metadata.label ?? metadata.kind ?? "task",
    summary: metadata.summary,
    owner: metadata.owner,
    enqueuedAt: now,
  };
}

export function cloneQueueTask(task: QueueTaskSnapshot): QueueTaskSnapshot {
  return { ...task };
}
