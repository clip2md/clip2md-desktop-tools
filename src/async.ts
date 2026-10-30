/** Bound native host promises that do not accept AbortSignal themselves. */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("素材任务已取消"),
      );
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error instanceof Error ? error : new Error("原站窗口调用失败"));
      },
    );
    if (signal.aborted) stop();
  });
}
