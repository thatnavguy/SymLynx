import * as vscode from 'vscode';
import * as path from 'path';
import { LinkInfo } from './types';
import { SymlinkManager } from './symlinkManager';

export interface LinkStats {
    total: number;
    broken: number;
}

export class LinkItem extends vscode.TreeItem {
    readonly linkInfo: LinkInfo;

    constructor(info: LinkInfo) {
        super(path.basename(info.linkPath), vscode.TreeItemCollapsibleState.None);
        this.linkInfo = info;

        const rel = path.relative(info.workspaceRoot, path.dirname(info.linkPath));

        if (info.isBroken) {
            this.description = `⚠ broken → ${info.targetPath}`;
        } else if (info.linkType === 'hardlink') {
            this.description = `⇒ ${info.targetPath}`;
        } else {
            this.description = `→ ${info.targetPath}`;
        }

        // 'symlinkBroken' lets the menu show Fix instead of Reveal for broken items
        this.contextValue = info.linkType === 'hardlink' ? 'hardlink'
            : info.isBroken ? 'symlinkBroken'
            : 'symlink';

        this.resourceUri = vscode.Uri.file(info.linkPath);

        const typeLabel = info.linkType === 'hardlink' ? 'Hard link'
            : info.isDirectory ? 'Directory symlink'
            : 'File symlink';
        const statusLabel = info.isBroken ? '⚠️ Broken (target missing)' : '✅ Valid';
        const arrowLabel = info.linkType === 'hardlink' ? 'Original' : 'Target';

        this.tooltip = new vscode.MarkdownString(
            [
                `**${path.basename(info.linkPath)}**`,
                '',
                `Location: \`${rel || '.'}\``,
                `${arrowLabel}: \`${info.targetAbsolute}\``,
                `Status: ${statusLabel}`,
                `Type: ${typeLabel}`,
            ].join('\n'),
            true
        );

        if (info.isBroken) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        } else if (info.linkType === 'hardlink') {
            this.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.orange'));
        } else if (info.isDirectory) {
            this.iconPath = new vscode.ThemeIcon('file-symlink-directory', new vscode.ThemeColor('symbolIcon.folderForeground'));
        } else {
            this.iconPath = new vscode.ThemeIcon('file-symlink-file', new vscode.ThemeColor('symbolIcon.fileForeground'));
        }

        this.command = {
            command: 'symlynx.revealInExplorer',
            title: 'Reveal in Explorer',
            arguments: [this],
        };
    }
}

export class SymlinkTreeProvider implements vscode.TreeDataProvider<LinkItem> {
    private readonly _onChange = new vscode.EventEmitter<LinkItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onChange.event;

    private readonly _onStats = new vscode.EventEmitter<LinkStats>();
    readonly onDidUpdateStats = this._onStats.event;

    private links: LinkInfo[] = [];
    private loading = false;
    private loaded = false;
    private treeView?: vscode.TreeView<LinkItem>;

    constructor(private readonly manager: SymlinkManager) {}

    setTreeView(view: vscode.TreeView<LinkItem>): void {
        this.treeView = view;
    }

    refresh(): void {
        this.loaded = false;
        this.links = [];
        this._onChange.fire();
    }

    getTreeItem(element: LinkItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<LinkItem[]> {
        const roots = vscode.workspace.workspaceFolders;

        if (!roots?.length) {
            this.setMessage('Open a folder or workspace to see links.');
            return [];
        }

        if (!this.loaded && !this.loading) {
            this.loading = true;
            this.setMessage('Scanning for symbolic links and hard links…');

            const allResults = await Promise.all(
                roots.map(f => this.manager.getAllLinks(f.uri.fsPath))
            );
            this.links = allResults.flat().sort((a, b) => a.linkPath.localeCompare(b.linkPath));

            this.loading = false;
            this.loaded = true;
            this.fireStats();
            this._onChange.fire();
        }

        if (this.loading) {
            this.setMessage('Scanning…');
            return [];
        }

        const symlinks = this.links.filter(l => l.linkType === 'symlink').length;
        const hardlinks = this.links.filter(l => l.linkType === 'hardlink').length;

        if (this.links.length === 0) {
            this.setMessage('No symbolic links or hard links found in workspace.');
        } else {
            const parts = [];
            if (symlinks) { parts.push(`${symlinks} symlink${symlinks !== 1 ? 's' : ''}`); }
            if (hardlinks) { parts.push(`${hardlinks} hard link${hardlinks !== 1 ? 's' : ''}`); }
            this.setMessage(parts.join(' · '));
        }

        return this.links.map(info => new LinkItem(info));
    }

    removeLink(linkPath: string): void {
        this.links = this.links.filter(l => l.linkPath !== linkPath);
        this.fireStats();
        this._onChange.fire();
    }

    addOrRefresh(): void {
        this.loaded = false;
        this.links = [];
        this._onChange.fire();
    }

    private setMessage(msg: string | undefined): void {
        if (this.treeView) {
            this.treeView.message = msg;
        }
    }

    private fireStats(): void {
        this._onStats.fire({
            total: this.links.length,
            broken: this.links.filter(l => l.isBroken).length,
        });
    }
}
