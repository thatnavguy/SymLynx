import * as vscode from 'vscode';
import { SymlinkManager } from './symlinkManager';
import { LinkItem, SymlinkTreeProvider } from './symlinkTreeProvider';
import { LinkPorter } from './linkPorter';

export function activate(context: vscode.ExtensionContext): void {
    const manager = new SymlinkManager(context);
    const porter = new LinkPorter(manager);
    const provider = new SymlinkTreeProvider(manager);

    const treeView = vscode.window.createTreeView('symlynx.symlinkExplorer', {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    provider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    // ── Status bar ──────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'symlynx.symlinkExplorer.focus';
    statusBar.tooltip = 'SymLynx — click to open Symbolic Links panel';
    context.subscriptions.push(statusBar);

    provider.onDidUpdateStats(stats => {
        if (!vscode.workspace.workspaceFolders?.length) {
            statusBar.hide();
            return;
        }
        if (stats.broken > 0) {
            statusBar.text = `$(link) ${stats.total}  $(warning) ${stats.broken}`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBar.text = `$(link) ${stats.total}`;
            statusBar.backgroundColor = undefined;
        }
        statusBar.show();
    }, null, context.subscriptions);

    // ── Commands ────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('symlynx.createSymlinkHere', async (uri?: vscode.Uri) => {
            const created = await manager.createSymlinkHere(uri);
            if (created) { provider.addOrRefresh(); }
        }),

        vscode.commands.registerCommand('symlynx.createSymlinkTo', async (uri?: vscode.Uri) => {
            const created = await manager.createSymlinkTo(uri);
            if (created) { provider.addOrRefresh(); }
        }),

        vscode.commands.registerCommand('symlynx.refresh', () => {
            provider.refresh();
        }),

        vscode.commands.registerCommand('symlynx.deleteSymlink', async (item: LinkItem) => {
            const deleted = await manager.deleteLink(item.linkInfo.linkPath, item.linkInfo.linkType);
            if (deleted) { provider.removeLink(item.linkInfo.linkPath); }
        }),

        vscode.commands.registerCommand('symlynx.fixBrokenTarget', async (item: LinkItem) => {
            const fixed = await manager.fixBrokenTarget(item.linkInfo.linkPath);
            if (fixed) { provider.addOrRefresh(); }
        }),

        vscode.commands.registerCommand('symlynx.renameLink', async (item: LinkItem) => {
            const newPath = await manager.renameLink(item.linkInfo.linkPath, item.linkInfo.linkType);
            if (newPath) { provider.addOrRefresh(); }
        }),

        vscode.commands.registerCommand('symlynx.revealInExplorer', async (item: LinkItem) => {
            await vscode.commands.executeCommand('revealInExplorer', item.resourceUri);
        }),

        vscode.commands.registerCommand('symlynx.revealTarget', async (item: LinkItem) => {
            const info = item.linkInfo;
            const targetUri = vscode.Uri.file(info.targetAbsolute);
            if (info.isDirectory) {
                const inWorkspace = vscode.workspace.getWorkspaceFolder(targetUri);
                if (inWorkspace) {
                    await vscode.commands.executeCommand('revealInExplorer', targetUri);
                } else {
                    await vscode.commands.executeCommand('revealFileInOS', targetUri);
                }
            } else {
                await vscode.window.showTextDocument(targetUri, { preview: true });
            }
        }),

        vscode.commands.registerCommand('symlynx.revealOriginal', async (item: LinkItem) => {
            const info = item.linkInfo;
            try {
                await vscode.window.showTextDocument(vscode.Uri.file(info.targetAbsolute), { preview: true });
            } catch {
                vscode.window.showWarningMessage(
                    `Original file is no longer at that path, but this hard link still contains the data: ${info.targetAbsolute}`
                );
            }
        }),

        vscode.commands.registerCommand('symlynx.revealTargetInOS', async (item: LinkItem) => {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.linkInfo.targetAbsolute));
        }),

        vscode.commands.registerCommand('symlynx.exportLinks', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            await porter.exportLinks(folders);
        }),

        vscode.commands.registerCommand('symlynx.importLinks', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const imported = await porter.importLinks(folders);
            if (imported) { provider.addOrRefresh(); }
        }),
    );
}

export function deactivate(): void {}
