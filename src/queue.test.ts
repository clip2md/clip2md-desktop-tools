import { describe, expect, it } from "vitest";
import { clearAllJobs, clearFailedJobs, enqueue, jobKey, readQueueState, pauseQueueForUpdate, queueCounts, serializeQueueState, MAX_QUEUE_SERIALIZED_BYTES } from "./queue";
import { normalizeSettings, platformFor, supportsFeature } from "./config";
import type { TaskContext } from "./companion-protocol";
const context: TaskContext = {
  bindingScope: "a".repeat(64),
  taskId: 42,
  sourceUrl: "https://www.bilibili.com/video/BV1234567890",
  contentVersion: "1:1",
  notePath: "Notes/a.md",
  daily: false,
};
describe("durable companion queue", () => {
  it("keeps all automatic features off and scopes settings by exact host", () => {
    const settings = normalizeSettings({});
    expect(
      Object.values(settings.platforms)
        .flatMap(Object.values)
        .every((v) => v === false),
    ).toBe(true);
    expect(platformFor("https://bilibili.com.evil.test/video/42")).toBe("web");
    expect(platformFor(context.sourceUrl)).toBe("bilibili");
    expect(supportsFeature("web", "comments")).toBe(false);
    expect(normalizeSettings({ commentLimit: 9999 }).commentLimit).toBe(1000);
  });
  it("deduplicates events, remembers completed downloads and permits explicit refresh", () => {
    const state = readQueueState(null);
    expect(enqueue(state, context, "video")).toBe(true);
    expect(enqueue(state, context, "video")).toBe(true);
    expect(state.jobs).toHaveLength(1);
    state.jobs[0].status = "complete";
    expect(enqueue(state, context, "video")).toBe(false);
    expect(enqueue(state, context, "video", true)).toBe(true);
    expect(
      enqueue(state, { ...context, bindingScope: "b".repeat(64) }, "video"),
    ).toBe(true);
    expect(state.jobs).toHaveLength(2);
  });
  it("recovers an interrupted job but leaves authorization and cancellation decisions intact", () => {
    const state = readQueueState(null);
    enqueue(state, context, "metadata");
    state.jobs[0].status = "running";
    expect(readQueueState(state).jobs[0].status).toBe("queued");
    state.jobs[0].status = "waiting-auth";
    expect(readQueueState(state).jobs[0].status).toBe("waiting-auth");
    state.jobs[0].status = "cancelled";
    expect(enqueue(state, context, "metadata")).toBe(false);
  });
  it("rejects corrupt identities and does not reconstruct a queue from malformed state", () => {
    const state = readQueueState(null);
    enqueue(state, context, "comments");
    state.jobs[0].key = "fake";
    expect(() => readQueueState(state)).toThrow();
    expect(() =>
      readQueueState({ version: 1, jobs: "bad", properties: {} }),
    ).toThrow();
    expect(jobKey(context, "metadata")).not.toBe(jobKey(context, "comments"));
  });
  it("requeues changed metadata without automatically redownloading completed video", () => {
    const state = readQueueState(null);
    enqueue(state, context, "metadata");
    state.jobs[0].status = "complete";
    expect(
      enqueue(state, { ...context, contentVersion: "1:2" }, "metadata"),
    ).toBe(true);
    expect(state.jobs[0].context.contentVersion).toBe("1:2");
  });
});

describe("update pause", () => {
  it.each([true, false])(
    "only requeues interrupted work when its binding is still current (%s)",
    async (current) => {
      const state = readQueueState(null);
      enqueue(state, context, "video");
      state.jobs[0].status = "running";
      const controller = new AbortController();
      controller.signal.addEventListener("abort", () => {
        state.jobs[0].status = "cancelled";
      });
      await pauseQueueForUpdate(
        state,
        controller,
        Promise.resolve(),
        () => current,
      );
      expect(state.jobs[0].status).toBe(current ? "queued" : "cancelled");
    },
  );
  it("preserves a user cancellation that happened before the update pause", async () => {
    const state = readQueueState(null);
    enqueue(state, context, "video");
    state.jobs[0].status = "cancelled";
    const controller = new AbortController();
    controller.abort();
    await pauseQueueForUpdate(state, controller, Promise.resolve(), () => true);
    expect(state.jobs[0].status).toBe("cancelled");
  });
});

describe("queue clearing", () => {
  it("clears the visible failed bucket, including cancelled jobs, only for the selected binding", () => {
    const state = readQueueState(null);
    enqueue(state, context, "video");
    enqueue(state, { ...context, bindingScope: "b".repeat(64) }, "video");
    enqueue(state, context, "images");
    state.jobs[0].status = "failed";
    state.jobs[1].status = "cancelled";
    state.jobs[2].status = "complete";
    expect(queueCounts(state.jobs.filter(job => job.context.bindingScope === context.bindingScope))).toEqual({
      "in-progress": 0,
      failed: 1,
      complete: 1,
    });
    const cleared = clearFailedJobs(state.jobs, context.bindingScope);
    expect(cleared).toHaveLength(2);
    expect(cleared.map(job => job.status)).toEqual(["cancelled", "complete"]);
  });
  it("aborts active work and clears every task in the selected binding", () => {
    const state = readQueueState(null);
    enqueue(state, context, "video");
    enqueue(state, context, "article");
    enqueue(state, { ...context, bindingScope: "b".repeat(64) }, "video");
    const abort = vi.fn();
    expect(clearAllJobs(state.jobs, context.bindingScope, abort)).toHaveLength(1);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("queue persistence limits", () => {
  it("rejects a serialized queue larger than the local storage budget", () => {
    const state = readQueueState(null);
    state.properties = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `source_title_${index}`,
        { source_title: "x".repeat(10000) },
      ]),
    );
    expect(() => serializeQueueState(state)).toThrow("本机素材队列过大");
    expect(MAX_QUEUE_SERIALIZED_BYTES).toBe(4 * 1024 * 1024);
  });
});
