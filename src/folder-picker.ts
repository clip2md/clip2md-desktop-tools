import { Modal, TFolder, type App } from "obsidian";

export class FolderPickerModal extends Modal {
    private newFolderOpen = false;
    private newFolderName = "";
    private newFolderError = "";
    private creatingFolder = false;
    private closed = false;
    private selectedPath = "";
    private filterQuery = "";
    private expandedFolders = new Set<string>();
    private readonly onSelect: (path: string) => void;
    private readonly root: TFolder;

    constructor(
        app: App,
        initialPath: string,
        onSelect: (path: string) => void,
        private readonly title = "选择目标文件夹",
    ) {
        super(app);
        const initial = initialPath && initialPath !== "/" ? app.vault.getAbstractFileByPath(initialPath) : null;
        this.selectedPath = initial instanceof TFolder ? initial.path : "";
        this.onSelect = onSelect;
        this.root = app.vault.getRoot();

        this.expandedFolders.add("");
        if (this.selectedPath) {
            const parts = this.selectedPath.split("/");
            let current = "";
            for (const part of parts) {
                this.expandedFolders.add(current);
                current = current ? `${current}/${part}` : part;
            }
        }
    }

    onOpen(): void {
        this.closed = false;
        this.contentEl.empty();
        this.titleEl.setText(this.title);

        const currentEl = this.contentEl.createDiv({
            cls: "clip2md-folder-picker-current",
            attr: { "aria-live": "polite" },
        });
        currentEl.createSpan({ text: "当前目录", cls: "clip2md-folder-picker-current-label" });
        currentEl.createEl("code", { text: this.selectedPath || "(根目录)" });

        const searchWrap = this.contentEl.createDiv({ cls: "clip2md-folder-picker-search" });
        const search = searchWrap.createEl("input", {
            attr: {
                type: "search",
                placeholder: "搜索文件夹…",
                "aria-label": "搜索文件夹",
                "data-control": "folder-picker-search",
            },
        });
        search.value = this.filterQuery;
        search.disabled = this.creatingFolder;
        search.addEventListener("input", () => {
            this.filterQuery = search.value;
            this.onOpen();
            const again = this.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]');
            again?.focus();
            again?.setSelectionRange(again.value.length, again.value.length);
        });
        if (this.filterQuery) {
            const clear = searchWrap.createEl("button", { text: "清除", cls: "clip2md-folder-picker-search-clear" });
            clear.type = "button";
            clear.addEventListener("click", () => {
                this.filterQuery = "";
                this.onOpen();
                this.contentEl.querySelector<HTMLInputElement>('[data-control="folder-picker-search"]')?.focus();
            });
        }

        const treeEl = this.contentEl.createDiv({ cls: "clip2md-folder-picker-tree" });
        const rendered = this.renderFolderTree(treeEl, this.root, 0, Boolean(this.filterQuery.trim()));
        if (!rendered) {
            const empty = treeEl.createDiv({ cls: "clip2md-folder-picker-empty", attr: { role: "status" } });
            empty.createEl("strong", { text: this.filterQuery.trim() ? "没有匹配的文件夹" : "暂无可选文件夹" });
            empty.createEl("p", { text: this.filterQuery.trim() ? "调整搜索词，或在下方新建文件夹。" : "可在下方新建文件夹。" });
        }

        const createArea = this.contentEl.createDiv({ cls: "clip2md-folder-picker-create" });
        const openCreate = createArea.createEl("button", { text: "新建文件夹", cls: "clip2md-folder-picker-new-toggle" });
        openCreate.type = "button";
        openCreate.disabled = this.creatingFolder;
        openCreate.addEventListener("click", () => {
            this.newFolderOpen = true;
            this.newFolderError = "";
            this.onOpen();
            this.contentEl.querySelector<HTMLInputElement>('[data-control="new-folder-name"]')?.focus();
        });

        if (this.newFolderOpen) {
            const location = createArea.createEl("p", { cls: "setting-item-description" });
            location.textContent = `新建位置：${this.selectedPath || "(根目录)"}`;
            const input = createArea.createEl("input", {
                attr: {
                    type: "text",
                    placeholder: "文件夹名称",
                    "aria-label": "新文件夹名称",
                    "data-control": "new-folder-name",
                },
            });
            input.value = this.newFolderName;
            input.disabled = this.creatingFolder;
            input.addEventListener("input", () => { this.newFolderName = input.value; });
            input.addEventListener("keydown", event => {
                if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault();
                    void this.createFolder();
                }
            });

            const create = createArea.createEl("button", { text: this.creatingFolder ? "创建中…" : "创建", cls: "mod-cta" });
            create.type = "button";
            create.disabled = this.creatingFolder;
            create.addEventListener("click", () => { void this.createFolder(); });

            const cancel = createArea.createEl("button", { text: "取消新建" });
            cancel.type = "button";
            cancel.disabled = this.creatingFolder;
            cancel.addEventListener("click", () => {
                this.newFolderOpen = false;
                this.newFolderName = "";
                this.newFolderError = "";
                this.onOpen();
            });

            if (this.newFolderError) {
                const error = createArea.createEl("p", { cls: "clip2md-error-text", attr: { role: "alert" } });
                error.textContent = this.newFolderError;
            }
        }

        const buttonContainer = this.contentEl.createDiv({ cls: "clip2md-folder-picker-buttons" });
        const select = buttonContainer.createEl("button", { text: "选择此文件夹", cls: "mod-cta" });
        select.type = "button";
        select.disabled = this.creatingFolder;
        select.addEventListener("click", () => {
            this.onSelect(this.selectedPath);
            this.close();
        });

        const cancel = buttonContainer.createEl("button", { text: "取消" });
        cancel.type = "button";
        cancel.addEventListener("click", () => this.close());
    }

    private async createFolder(): Promise<void> {
        if (this.creatingFolder || this.closed) return;
        const name = this.newFolderName.trim();
        if (!name || name === "." || name === ".." || /[/\\<>:"|?*]/.test(name) || Array.from(name).some(char => char.charCodeAt(0) < 32)) {
            this.newFolderError = "请输入有效的单个文件夹名称，不能包含 /、\\ 或系统保留字符。";
            this.renderCreationError();
            return;
        }

        const parent = this.selectedPath;
        const path = parent ? `${parent}/${name}` : name;
        if (this.app.vault.getAbstractFileByPath(path)) {
            this.newFolderError = "该名称已存在，请使用其他名称。";
            this.renderCreationError();
            return;
        }
        if (parent && !(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) {
            this.newFolderError = "选中目录已不存在，请重新选择。";
            this.renderCreationError();
            return;
        }

        this.creatingFolder = true;
        this.newFolderError = "";
        this.onOpen();
        try {
            await this.app.vault.createFolder(path);
            this.selectedPath = path;
            this.expandedFolders.add(parent);
            this.newFolderOpen = false;
            this.newFolderName = "";
        }
        catch (error) {
            this.newFolderError = error instanceof Error ? error.message : "创建失败，请重试。";
        }
        finally {
            this.creatingFolder = false;
            if (!this.closed) {
                if (this.newFolderError) this.renderCreationError();
                else {
                    this.onOpen();
                    Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>(".clip2md-tree-item"))
                        .find(button => button.dataset.path === this.selectedPath)?.focus();
                }
            }
        }
    }

    private renderCreationError(): void {
        this.onOpen();
        this.contentEl.querySelector<HTMLInputElement>('[data-control="new-folder-name"]')?.focus();
    }

    private renderFolderTree(containerEl: HTMLElement, folder: TFolder, depth: number, filtering: boolean): boolean {
        const isRoot = depth === 0;
        const path = isRoot ? "" : folder.path;
        const isExpanded = this.expandedFolders.has(path);
        const isSelected = this.selectedPath === path;
        const query = this.filterQuery.trim().toLocaleLowerCase();
        const matches = !query || (!isRoot && (path.toLocaleLowerCase().includes(query) || folder.name.toLocaleLowerCase().includes(query)));
        const children = folder.children
            .filter((child): child is TFolder => child instanceof TFolder)
            .sort((a, b) => a.name.localeCompare(b.name));
        const renderedChildren: HTMLElement[] = [];

        for (const child of children) {
            const childWrap = containerEl.createDiv();
            if (this.renderFolderTree(childWrap, child, depth + 1, filtering)) renderedChildren.push(childWrap);
        }
        if (!matches && renderedChildren.length === 0) return false;

        const hasSubfolders = children.length > 0;
        const itemEl = containerEl.createEl("button", { cls: `clip2md-tree-item ${isSelected ? "selected" : ""}` });
        containerEl.insertBefore(itemEl, containerEl.firstChild);
        itemEl.type = "button";
        itemEl.dataset.path = path;
        itemEl.setAttribute("aria-pressed", String(isSelected));
        if (hasSubfolders) itemEl.setAttribute("aria-expanded", String(filtering || isExpanded));
        itemEl.disabled = this.creatingFolder;
        itemEl.setCssProps({ "--clip2md-tree-item-padding-left": `${depth * 16 + 8}px` });

        itemEl.createSpan({ text: hasSubfolders ? (filtering || isExpanded ? "▼" : "▶") : " ", cls: "clip2md-tree-toggle" });
        itemEl.createSpan({ text: "📁", cls: "clip2md-tree-icon" });
        itemEl.createSpan({ text: isRoot ? "(根目录)" : folder.name, cls: "clip2md-tree-name" });

        itemEl.addEventListener("click", () => {
            this.selectedPath = path;
            if (hasSubfolders && !filtering) {
                if (isExpanded) this.expandedFolders.delete(path);
                else this.expandedFolders.add(path);
            }
            this.onOpen();
            Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>(".clip2md-tree-item"))
                .find(button => button.dataset.path === path)?.focus();
        });

        if (!filtering && hasSubfolders && !isExpanded) renderedChildren.forEach(element => element.remove());
        return true;
    }

    onClose(): void {
        this.closed = true;
        this.contentEl.empty();
    }
}
