/** Decode bounded, source-published stream tuples as data; never execute or scan arbitrary source text. */
export function paceStatePayloads(entries: unknown[]): unknown[] {
  if (entries.length > 160) return [];
  const chunks: string[] = [];
  let size = 0;
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      entry[0] !== 1 ||
      typeof entry[1] !== "string"
    )
      continue;
    size += entry[1].length;
    if (size > 2 * 1024 * 1024) return [];
    chunks.push(entry[1]);
  }
  if (!chunks.length) return [];
  const decode = (input: string): unknown => {
    let text = input.trim();
    for (
      let pass = 0;
      pass < 2 && /^%(?:7b|5b|22|25(?:7b|5b|22))/i.test(text);
      pass++
    ) {
      try {
        text = decodeURIComponent(text);
      } catch {
        return;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object") return value;
        if (typeof value !== "string") return;
        text = value;
      } catch {
        return;
      }
    }
  };
  const joined = chunks.join(""),
    whole = decode(joined);
  if (whole) return [whole];
  // Newline-delimited JSON records can have a short hexadecimal transport index.
  // Preserve order and complete records; never mine JSON-looking prose or partial object substrings.
  const result: unknown[] = [];
  for (const chunk of chunks) {
    const value = decode(chunk);
    if (value) result.push(value);
  }
  const lines = joined.split(/\r?\n/);
  if (lines.length > 320) return [];
  for (const line of lines) {
    const text = line.replace(/^[0-9a-f]{1,8}:/i, "").trim(),
      value = decode(text);
    if (value && result.length < 320) result.push(value);
  }
  return result;
}
