/** HTML table grid → pipe Markdown; covered slots stay blank, never shift source values. */
// HTML table cell spans and row groups: https://html.spec.whatwg.org/multipage/tables.html
export function sourceTableMarkdown(
  table: HTMLTableElement,
  convert: (html: string) => string,
): string {
  // Turndown's Node DOM supports table children but not table.caption.
  const sourceCaption = Array.from(table.children).find(
    (node) => node.tagName === "CAPTION",
  );
  const rows = Array.from(table.rows);
  if (!rows.length)
    return sourceCaption
      ? "\n\n" + convert(sourceCaption.innerHTML) + "\n\n"
      : "";
  if (rows.length > 10000)
    throw new Error("原文表格超过本地行数限制，未保存截断表格");
  const grid: Array<Array<string | undefined>> = rows.map(() => []);
  const groupEnds: number[] = [];
  for (let y = rows.length - 1; y >= 0; y--)
    groupEnds[y] =
      rows[y + 1]?.parentElement === rows[y].parentElement
        ? groupEnds[y + 1]
        : y + 1;
  const header =
    rows[0].parentElement?.tagName === "THEAD" ||
    (rows[0].cells.length > 0 &&
      Array.from(rows[0].cells).every(
        (cell) =>
          cell.tagName === "TH" &&
          !["row", "rowgroup"].includes(
            (cell.getAttribute("scope") || "").toLowerCase(),
          ),
      ));
  let width = 0,
    merged = false;
  for (const [y, row] of rows.entries()) {
    let x = 0;
    const end = groupEnds[y];
    for (const cell of Array.from(row.cells)) {
      while (grid[y][x] !== undefined) x++;
      const across = cell.colSpan,
        down = cell.rowSpan === 0 ? end - y : cell.rowSpan;
      width = Math.max(width, x + across);
      if (width > 256 || width * rows.length > 10000)
        throw new Error("原文表格展开后超过本地大小限制，未保存错位表格");
      if (y + down > end)
        throw new Error("原文表格合并区域跨越行组或缺少行，未保存错位表格");
      for (let dy = y; dy < y + down; dy++)
        for (let dx = x; dx < x + across; dx++) {
          if (grid[dy][dx] !== undefined)
            throw new Error("原文表格合并区域重叠，未保存错位表格");
          grid[dy][dx] = "";
        }
      let value = convert(cell.innerHTML)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, "<br>");
      if (
        value &&
        cell.tagName === "TH" &&
        !(header && y === 0) &&
        !(value.startsWith("**") && value.endsWith("**"))
      )
        value = `**${value}**`;
      grid[y][x] = value;
      merged ||= across > 1 || down > 1;
      x += across;
    }
  }
  if (!width) return "";
  const line = (values: Array<string | undefined>) =>
    `| ${Array.from({ length: width }, (_, i) => values[i] || "").join(" | ")} |`;
  const output = grid.map(line);
  if (!header) output.unshift(line([]));
  output.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
  const caption = sourceCaption ? convert(sourceCaption.innerHTML).trim() : "";
  const notice = merged
    ? "> 原表含合并单元格；以下按原列位置展开，覆盖位置留空。\n\n"
    : "";
  return (
    "\n\n" +
    (caption ? caption + "\n\n" : "") +
    notice +
    output.join("\n") +
    "\n\n"
  );
}
