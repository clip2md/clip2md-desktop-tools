import { parse } from "acorn";

/** Read explicit publication data, never run source JavaScript or inspect nested articles. */
export function literalWechatDate(document: Document): string | undefined {
  const timestamps = new Set<number>();
  let uncertain = false;
  for (const script of Array.from(document.scripts)) {
    const type = script.type.trim().toLowerCase();
    if (
      script.hasAttribute("src") ||
      (type &&
        ![
          "module",
          "text/javascript",
          "application/javascript",
          "text/ecmascript",
          "application/ecmascript",
        ].includes(type))
    )
      continue;
    const source = script.textContent || "";
    if (!/\bct\b/.test(source)) continue;
    try {
      const program = parse(source, {
        ecmaVersion: "latest",
        sourceType: type === "module" ? "module" : "script",
      });
      for (const node of program.body) {
        if (node.type === "ExpressionStatement") {
          const expression = node.expression;
          const target =
            expression.type === "AssignmentExpression"
              ? expression.left
              : expression.type === "UpdateExpression"
                ? expression.argument
                : undefined;
          if (target?.type === "Identifier" && target.name === "ct")
            uncertain = true;
        }
        if (node.type !== "VariableDeclaration") continue;
        for (const declaration of node.declarations) {
          if (
            declaration.id.type !== "Identifier" ||
            declaration.id.name !== "ct"
          )
            continue;
          const value =
            declaration.init?.type === "Literal"
              ? declaration.init.value
              : undefined;
          if (
            (typeof value === "string" || typeof value === "number") &&
            /^\d{10}$/.test(String(value)) &&
            Number(value) > 0
          )
            timestamps.add(Number(value));
          else uncertain = true;
        }
      }
    } catch {
      /* Invalid/unsupported source syntax is not publication evidence. */
    }
  }
  if (uncertain || timestamps.size !== 1) return;
  return new Date([...timestamps][0] * 1000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
}
