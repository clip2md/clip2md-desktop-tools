/** Read public page data as literals. Never evaluate site JavaScript. */
import { parse } from "acorn";
import { paceStatePayloads } from "./pace-state";

type Node = any;
function literal(
  node: Node,
  budget: { remaining: number },
  depth = 0,
): unknown {
  if (!node || depth > 50 || --budget.remaining < 0)
    throw new Error("state budget");
  if (node.type === "Literal" && !node.regex && typeof node.value !== "bigint")
    return node.value;
  if (node.type === "Identifier" && node.name === "undefined") return null;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument?.type === "Literal" &&
    typeof node.argument.value === "number"
  )
    return -node.argument.value;
  // Decode a serialized literal, without invoking any function from the source page.
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "JSON" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "parse" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    typeof node.arguments[0].value === "string"
  )
    return JSON.parse(node.arguments[0].value);
  if (node.type === "ArrayExpression")
    return node.elements.map((item: Node) =>
      item ? literal(item, budget, depth + 1) : null,
    );
  if (node.type === "ObjectExpression") {
    const result = Object.create(null);
    for (const property of node.properties) {
      if (
        property.type !== "Property" ||
        property.computed ||
        property.method ||
        property.kind !== "init"
      )
        throw new Error("not literal");
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.value;
      if (typeof key !== "string" && typeof key !== "number")
        throw new Error("not a key");
      result[String(key)] = literal(property.value, budget, depth + 1);
    }
    return result;
  }
  throw new Error("not literal");
}

export function publicPageStates(document: Document): unknown[] {
  const states: unknown[] = [];
  const pace: unknown[] = [];
  let paceOverflow = false;
  const addPace = (entries: unknown[]) => {
    if (pace.length + entries.length > 160) {
      paceOverflow = true;
      return;
    }
    pace.push(...entries);
  };
  const paceReference = (node: Node) =>
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    ["self", "window", "globalThis"].includes(node.object.name) &&
    node.property.type === "Identifier" &&
    node.property.name === "__pace_f";
  const globals = new Set([
    "__INITIAL_STATE__",
    "_ROUTER_DATA",
    "__NEXT_DATA__",
    "__INITIAL_DATA__",
  ]);
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-clip2md-live-state]"))) {
    const text = node.textContent || "";
    if (!text || text.length > 2 * 1024 * 1024) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (node.getAttribute("data-clip2md-live-state") === "__pace_f") {
        if (Array.isArray(value)) addPace(value);
      } else states.push(value);
    } catch {
      /* Script-backed state is parsed below; malformed state is ignored. */
    }
  }
  for (const script of Array.from(document.scripts).slice(0, 128)) {
    const text = script.textContent || "";
    if (script.src || !text || text.length > 2 * 1024 * 1024) continue;
    if (
      ["__NEXT_DATA__", "RENDER_DATA"].includes(script.id) ||
      script.type === "application/json"
    ) {
      try {
        const value: unknown = JSON.parse(text);
        if (script.getAttribute("data-clip2md-live-state") === "__pace_f") {
          if (Array.isArray(value)) addPace(value);
        } else states.push(value);
      } catch {
        if (script.id === "RENDER_DATA")
          try {
            states.push(JSON.parse(decodeURIComponent(text)));
          } catch {
            /* No script execution fallback. */
          }
      }
      continue;
    }
    if (
      script.type &&
      !["text/javascript", "application/javascript", "module"].includes(
        script.type,
      )
    )
      continue;
    if (![...globals, "__pace_f"].some((name) => text.includes(name))) continue;
    try {
      const program = parse(text, {
        ecmaVersion: "latest",
        sourceType: script.type === "module" ? "module" : "script",
      });
      for (const statement of program.body) {
        const expression =
          statement.type === "ExpressionStatement"
            ? statement.expression
            : undefined;
        const left =
          expression?.type === "AssignmentExpression" &&
          expression.operator === "="
            ? expression.left
            : undefined;
        if (
          expression?.type === "AssignmentExpression" &&
          paceReference(left)
        ) {
          try {
            const value = literal(expression.right, { remaining: 100000 });
            if (Array.isArray(value)) addPace(value);
          } catch {
            /* Not literal stream data. */
          }
        }
        if (
          expression?.type === "CallExpression" &&
          expression.arguments.length === 1 &&
          expression.callee.type === "MemberExpression" &&
          !expression.callee.computed &&
          expression.callee.property.type === "Identifier" &&
          expression.callee.property.name === "push"
        ) {
          const target = expression.callee.object;
          const initialized =
            target.type === "AssignmentExpression" &&
            target.operator === "=" &&
            paceReference(target.left) &&
            target.right.type === "LogicalExpression" &&
            target.right.operator === "||" &&
            paceReference(target.right.left) &&
            target.right.right.type === "ArrayExpression" &&
            target.right.right.elements.length === 0;
          if (paceReference(target) || initialized)
            try {
              addPace([
                literal(expression.arguments[0], { remaining: 100000 }),
              ]);
            } catch {
              /* Never evaluate arguments. */
            }
        }
        if (
          expression?.type === "AssignmentExpression" &&
          left?.type === "MemberExpression" &&
          !left.computed &&
          left.object.type === "Identifier" &&
          ["window", "globalThis"].includes(left.object.name) &&
          left.property.type === "Identifier" &&
          globals.has(left.property.name)
        ) {
          try {
            states.push(literal(expression.right, { remaining: 100000 }));
          } catch {
            /* Unsupported expressions are not data. */
          }
        }
        if (statement.type === "VariableDeclaration")
          for (const declaration of statement.declarations) {
            if (
              declaration.id.type === "Identifier" &&
              globals.has(declaration.id.name)
            ) {
              try {
                states.push(literal(declaration.init, { remaining: 100000 }));
              } catch {
                /* Do not run initializers. */
              }
            }
          }
      }
    } catch {
      /* Invalid syntax is not a usable state snapshot. */
    }
  }
  if (!paceOverflow) states.push(...paceStatePayloads(pace));
  return states;
}

export function records(
  states: unknown[],
  predicate: (row: Record<string, any>) => boolean,
): Array<Record<string, any>> {
  const found: Array<Record<string, any>> = [],
    queue: Array<{ value: unknown; depth: number }> = states.map((value) => ({
      value,
      depth: 0,
    }));
  for (let i = 0; i < queue.length && i < 100000; i++) {
    const { value, depth } = queue[i];
    if (!value || typeof value !== "object" || depth > 40) continue;
    if (!Array.isArray(value) && predicate(value as Record<string, any>))
      found.push(value as Record<string, any>);
    for (const item of Object.values(value)) {
      if (queue.length >= 100000) break;
      if (item && typeof item === "object")
        queue.push({ value: item, depth: depth + 1 });
    }
  }
  return found;
}
