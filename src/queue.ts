import {
  isTaskContext,
  validateProperties,
  type LocalProperties,
  type TaskContext,
} from "./companion-protocol";
import { FEATURES, type Feature } from "./config";
import { hash } from "./storage";
export type JobStatus =
  | "queued"
  | "running"
  | "waiting-auth"
  | "waiting-write"
  | "failed"
  | "cancelled"
  | "complete";
export type QueueBucket = "in-progress" | "failed" | "complete";
export interface SavedMaterial {
  properties: LocalProperties;
  assets: string[];
  files: Array<{ path: string; sha256: string }>;
}
export interface Job {
  saved?: SavedMaterial;
  replaceUserValues?: boolean;
  key: string;
  context: TaskContext;
  feature: Feature;
  status: JobStatus;
  message: string;
  attempts: number;
  retryCount?: number;
  nextAttemptAt?: number;
  lastError?: string;
  cloudStatus?: "success" | "failed" | "pending" | "unknown";
}
export interface QueueState {
  version: 1;
  jobs: Job[];
  properties: Record<string, LocalProperties>;
}
/** Keep persisted queue data below the browser localStorage quota. */
export const MAX_QUEUE_SERIALIZED_BYTES = 4 * 1024 * 1024;
export function serializeQueueState(state: QueueState): string {
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).byteLength > MAX_QUEUE_SERIALIZED_BYTES)
    throw new Error("本机素材队列过大，请清理完成记录或素材后重试");
  return serialized;
}
/** Maps every persisted job to exactly one user-facing queue group. */
export function queueBucket(job: Pick<Job, "status">): QueueBucket {
  if (job.status === "complete") return "complete";
  if (job.status === "failed" || job.status === "cancelled") return "failed";
  return "in-progress";
}
export function queueCounts(jobs: Array<Pick<Job, "status">>): Record<QueueBucket, number> {
  return jobs.reduce((counts, job) => { counts[queueBucket(job)]++; return counts; }, {
    "in-progress": 0,
    failed: 0,
    complete: 0,
  } as Record<QueueBucket, number>);
}
/** Remove the visible failed bucket while preserving all other job states. */
export function clearFailedJobs(
  jobs: Job[],
  bindingScope: string,
): Job[] {
  return jobs.filter(
    (job) =>
      job.context.bindingScope !== bindingScope || queueBucket(job) !== "failed",
  );
}
/** Stop and remove every job belonging to one selection without touching other bindings. */
export function clearAllJobs(
  jobs: Job[],
  bindingScope: string,
  abortActive: () => void,
): Job[] {
  abortActive();
  return jobs.filter((job) => job.context.bindingScope !== bindingScope);
}
export const taskKey = (context: TaskContext) =>
  `${context.bindingScope}:${context.taskId}`;
export function jobKey(context: TaskContext, feature: Feature): string {
  return hash(`${taskKey(context)}:${context.sourceUrl}:${feature}`);
}
export function readQueueState(value: unknown): QueueState {
  if (value == null) return { version: 1, jobs: [], properties: {} };
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("本地素材队列损坏，已暂停处理");
  // Reject oversized persisted data before walking all nested job fields.
  serializeQueueState(value as QueueState);
  const v = value as QueueState;
  if (
    v.version !== 1 ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 5000 ||
    !v.properties ||
    typeof v.properties !== "object" ||
    Array.isArray(v.properties) ||
    !Object.values(v.properties).every(validateProperties) ||
    !v.jobs.every(
      (j) =>
        j &&
        (!j.saved ||
          (validateProperties(j.saved.properties) &&
            Array.isArray(j.saved.assets) &&
            j.saved.assets.every(
              (p) =>
                typeof p === "string" &&
                !p.startsWith("/") &&
                !p.split("/").includes(".."),
            ) &&
            Array.isArray(j.saved.files) &&
            j.saved.files.length <= j.saved.assets.length &&
            j.saved.files.every(
              (f) =>
                f &&
                j.saved!.assets.includes(f.path) &&
                /^[a-f0-9]{64}$/.test(f.sha256),
            ))) &&
        isTaskContext(j.context) &&
        FEATURES.includes(j.feature) &&
        j.key === jobKey(j.context, j.feature) &&
        [
          "queued",
          "running",
          "waiting-auth",
          "waiting-write",
          "failed",
          "cancelled",
          "complete",
        ].includes(j.status) &&
        typeof j.message === "string" &&
        Number.isSafeInteger(j.attempts) &&
        j.attempts >= 0 &&
        (j.retryCount === undefined || (Number.isSafeInteger(j.retryCount) && j.retryCount >= 0)) &&
        (j.nextAttemptAt === undefined || (Number.isSafeInteger(j.nextAttemptAt) && j.nextAttemptAt >= 0)) &&
        (j.lastError === undefined || typeof j.lastError === 'string') &&
        (j.cloudStatus === undefined || ['success','failed','pending','unknown'].includes(j.cloudStatus)),
    )
  )
    throw new Error("本地素材队列损坏，已暂停处理");
  if (new Set(v.jobs.map((j) => j.key)).size !== v.jobs.length)
    throw new Error("本地素材队列身份重复，已暂停处理");
  return {
    ...v,
    jobs: v.jobs.map((j) => ({
      ...j,
      retryCount: Number.isSafeInteger(j.retryCount) && j.retryCount! >= 0 ? j.retryCount : 0,
      cloudStatus: j.cloudStatus === 'success' || j.cloudStatus === 'failed' || j.cloudStatus === 'pending' ? j.cloudStatus : 'unknown',
      status: j.status === "running" ? "queued" : j.status,
      message: j.status === "running" ? "上次处理被中断，等待恢复" : j.message,
    })),
  };
}
export function enqueue(
  state: QueueState,
  context: TaskContext,
  feature: Feature,
  manual = false,
): boolean {
  const key = jobKey(context, feature),
    existing = state.jobs.find((j) => j.key === key);
  if (existing) {
    if (
      !manual &&
      feature === "metadata" &&
      existing.status === "complete" &&
      existing.context.contentVersion !== context.contentVersion
    ) {
      existing.status = "queued";
      delete existing.saved;
    }
    if (
      existing.status === "running" ||
      (!manual &&
        ["complete", "waiting-auth", "cancelled", "failed"].includes(
          existing.status,
        ))
    )
      return false;
    if (manual && existing.status === "complete") delete existing.saved;
    existing.context = { ...context };
    existing.status = "queued";
    existing.message = "等待处理";
    existing.retryCount = manual ? 0 : existing.retryCount || 0;
    delete existing.nextAttemptAt;
    delete existing.lastError;
    return true;
  }
  if (state.jobs.length >= 5000)
    throw new Error("本地队列已满，请清理完成记录后重试");
  state.jobs.push({
    key,
    context: { ...context },
    feature,
    status: "queued",
    message: "等待处理",
    attempts: 0,
    retryCount: 0,
    cloudStatus: 'unknown',
  });
  return true;
}

/** Preserve update-interrupted work while leaving user cancellations and old bindings cancelled. */
export async function pauseQueueForUpdate(
  state: QueueState,
  active: AbortController | null,
  running: Promise<void> | null,
  isCurrent: () => boolean,
): Promise<void> {
  const interrupted =
    active && !active.signal.aborted
      ? state.jobs.find((job) => job.status === "running")
      : undefined;
  active?.abort();
  await running;
  if (interrupted?.status === "cancelled" && isCurrent()) {
    interrupted.status = "queued";
    interrupted.message = "更新期间暂停，恢复后继续";
  }
}
