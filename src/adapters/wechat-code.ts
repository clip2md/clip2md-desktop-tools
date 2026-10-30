/** Normalize the WeChat editor's explicit line-per-code DOM, without running source code. */
export function normalizeWechatCode(content: HTMLElement): void {
  for (const pre of Array.from(
    content.querySelectorAll<HTMLElement>("pre.code-snippet__js"),
  )) {
    const lines = Array.from(pre.children);
    // Unknown layouts keep the generic preformatted-text path. Whitespace
    // between line elements is editor formatting, not part of the code.
    if (
      !lines.length ||
      lines.some((node) => node.tagName !== "CODE") ||
      Array.from(pre.childNodes).some(
        (node) => node.nodeType === 3 && !!node.textContent?.trim(),
      )
    )
      continue;
    for (const line of lines)
      line
        .querySelectorAll("br")
        .forEach((node) =>
          node.replaceWith(content.ownerDocument.createTextNode("\n")),
        );
    const code = content.ownerDocument.createElement("code");
    code.textContent = lines.map((line) => line.textContent || "").join("\n");
    // code-snippet__js is the editor layout class, not proof of JavaScript.
    const declared = pre.getAttribute("data-lang");
    const language =
      declared === null
        ? [...Array.from(lines[0].classList), ...Array.from(pre.classList)]
            .find((name) => /^language-[a-z0-9][a-z0-9_-]{0,63}$/i.test(name))
            ?.slice(9)
        : declared.trim();
    if (language && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(language))
      code.className = `language-${language}`;
    pre.replaceChildren(code);
    const wrapper = pre.parentElement;
    if (wrapper?.classList.contains("code-snippet__fix")) {
      for (const node of Array.from(wrapper.children)) {
        if (
          node !== pre &&
          node.classList.contains("code-snippet__line-index") &&
          ["UL", "OL"].includes(node.tagName)
        )
          node.remove();
      }
    }
  }
}
