/** Bilibili public JSON cues use seconds; this does not prove full-video coverage. */
export function bilibiliSubtitleMarkdown(
  payload: any,
  duration?: number,
): string | undefined {
  const rows = payload?.body;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100000) return;
  // The selected page duration may be rounded to whole seconds. Never use
  // the collection duration, nor require the last spoken cue to reach it.
  const limit =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? duration + 1
      : undefined;
  let previous = -1;
  const output: string[] = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row.content !== "string" ||
      !row.content.trim() ||
      typeof row.from !== "number" ||
      !Number.isFinite(row.from) ||
      row.from < 0 ||
      row.from > Number.MAX_SAFE_INTEGER ||
      typeof row.to !== "number" ||
      !Number.isFinite(row.to) ||
      row.to < row.from ||
      row.to > Number.MAX_SAFE_INTEGER ||
      row.from < previous ||
      (limit !== undefined && row.to > limit)
    )
      return;
    previous = row.from;
    const seconds = Math.floor(row.from);
    const clock = [
      Math.floor(seconds / 3600),
      Math.floor(seconds / 60) % 60,
      seconds % 60,
    ]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
    output.push(
      `[${clock}] ${row.content.replace(/[\\`*_[\]<>]/g, "\\$&").trim()}`,
    );
  }
  return output.join("\n\n");
}
