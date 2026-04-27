import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LinkInfo, LinkType } from './types';
import { SymlinkManager } from './symlinkManager';

const EXPORT_VERSION = 1;

interface ExportRecord {
    linkRelativePath: string;
    targetAbsolute: string;
    targetRelativeToWorkspace: string | null;
    linkType: LinkType;
    isDirectory: boolean;
}

interface ExportFile {
    version: number;
    symlynxExport: true;
    exportedFromWorkspace: string;
    exportedAt: string;
    links: ExportRecord[];
}

interface ImportItem extends vscode.QuickPickItem {
    record: ExportRecord;
    resolvedTarget: string;
    canCreate: boolean;
}

export class LinkPorter {
    constructor(private readonly manager: SymlinkManager) {}

    // ── Export ──────────────────────────────────────────────────────────────

    async exportLinks(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
        if (!workspaceFolders.length) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const allLinks: LinkInfo[] = (
            await Promise.all(workspaceFolders.map(f => this.manager.getAllLinks(f.uri.fsPath)))
        ).flat();

        if (allLinks.length === 0) {
            vscode.window.showInformationMessage('No symlinks or hard links found to export.');
            return;
        }

        const primaryRoot = workspaceFolders[0].uri.fsPath;

        const records: ExportRecord[] = allLinks.map(link => {
            const linkRelativePath = path.relative(link.workspaceRoot, link.linkPath).replace(/\\/g, '/');
            const targetNorm = link.targetAbsolute.toLowerCase();
            const rootNorm = link.workspaceRoot.toLowerCase();
            const targetRelativeToWorkspace = targetNorm.startsWith(rootNorm)
                ? path.relative(link.workspaceRoot, link.targetAbsolute).replace(/\\/g, '/')
                : null;
            return {
                linkRelativePath,
                targetAbsolute: link.targetAbsolute.replace(/\\/g, '/'),
                targetRelativeToWorkspace,
                linkType: link.linkType,
                isDirectory: link.isDirectory,
            };
        });

        const exportFile: ExportFile = {
            version: EXPORT_VERSION,
            symlynxExport: true,
            exportedFromWorkspace: primaryRoot.replace(/\\/g, '/'),
            exportedAt: new Date().toISOString(),
            links: records,
        };

        const defaultName = `${path.basename(primaryRoot)}.symlynx`;
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(primaryRoot, defaultName)),
            filters: { 'SymLynx Export': ['symlynx'], 'JSON': ['json'] },
            title: 'Export SymLynx Links',
            saveLabel: 'Export',
        });
        if (!saveUri) { return; }

        await fs.promises.writeFile(saveUri.fsPath, JSON.stringify(exportFile, null, 2), 'utf8');
        vscode.window.showInformationMessage(
            `Exported ${records.length} link${records.length !== 1 ? 's' : ''} to ${path.basename(saveUri.fsPath)}`
        );
    }

    // ── Import ──────────────────────────────────────────────────────────────

    async importLinks(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<boolean> {
        if (!workspaceFolders.length) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return false;
        }

        const filePicked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'SymLynx Export': ['symlynx'], 'JSON': ['json'] },
            title: 'Import SymLynx Links',
            openLabel: 'Import',
        });
        if (!filePicked?.length) { return false; }

        let exportFile: ExportFile;
        try {
            const raw = await fs.promises.readFile(filePicked[0].fsPath, 'utf8');
            exportFile = JSON.parse(raw);
            if (!exportFile.symlynxExport || exportFile.version !== EXPORT_VERSION) {
                throw new Error('Not a valid SymLynx export file.');
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to read export file: ${(err as Error).message}`);
            return false;
        }

        // Destination workspace
        let destRoot: string;
        if (workspaceFolders.length === 1) {
            destRoot = workspaceFolders[0].uri.fsPath;
        } else {
            const choice = await vscode.window.showQuickPick(
                workspaceFolders.map(f => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })),
                { title: 'Select destination workspace folder', placeHolder: 'Where to create the links' }
            );
            if (!choice) { return false; }
            destRoot = choice.root;
        }

        // Remap offer
        const sourceRoot = exportFile.exportedFromWorkspace.replace(/\//g, path.sep);
        const isSameWorkspace = sourceRoot.toLowerCase() === destRoot.toLowerCase();
        const hasInternalTargets = exportFile.links.some(l => l.targetRelativeToWorkspace !== null);

        let remapRoot: string | null = null;
        if (hasInternalTargets && !isSameWorkspace) {
            const choice = await vscode.window.showInformationMessage(
                `${exportFile.links.filter(l => l.targetRelativeToWorkspace).length} link(s) have targets ` +
                `inside the source workspace "${path.basename(sourceRoot)}". ` +
                `Remap them to the current workspace "${path.basename(destRoot)}"?`,
                { modal: true },
                'Yes, Remap',
                'No, Keep Original Paths',
            );
            if (choice === undefined) { return false; }
            if (choice === 'Yes, Remap') { remapRoot = destRoot; }
        }

        // Build QuickPick items
        const items: ImportItem[] = exportFile.links.map(record => {
            const resolvedTarget = this.resolveTarget(record, sourceRoot, remapRoot);
            const linkAbsPath = path.join(destRoot, record.linkRelativePath.replace(/\//g, path.sep));
            const alreadyExists = this.pathExists(linkAbsPath);
            const targetExists = this.pathExists(resolvedTarget);
            const canCreate = !alreadyExists && (record.linkType !== 'hardlink' || targetExists);

            const typeIcon = record.linkType === 'hardlink' ? 'link'
                : record.isDirectory ? 'file-symlink-directory'
                : 'file-symlink-file';

            let detail: string;
            if (alreadyExists) {
                detail = `$(warning) Already exists at destination — will skip`;
            } else if (!targetExists && record.linkType === 'hardlink') {
                detail = `$(error) Target not found — hard links require an existing file`;
            } else if (!targetExists) {
                detail = `$(warning) Target not found — symlink will be broken`;
            } else {
                detail = `$(check) Ready`;
            }

            return {
                label: `$(${typeIcon}) ${path.basename(record.linkRelativePath)}`,
                description: record.linkRelativePath,
                detail: `${detail}   →  ${resolvedTarget}`,
                picked: canCreate,
                record,
                resolvedTarget,
                canCreate,
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: `Import from "${path.basename(filePicked[0].fsPath)}" into "${path.basename(destRoot)}"`,
            placeHolder: 'Select links to import — deselect any to skip',
        });
        if (!selected?.length) { return false; }

        // Create selected links
        let created = 0;
        let failed = 0;
        const errors: string[] = [];

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Importing links…', cancellable: false },
            async progress => {
                for (const item of selected) {
                    const linkPath = path.join(destRoot, item.record.linkRelativePath.replace(/\//g, path.sep));
                    progress.report({ message: path.basename(linkPath) });

                    try {
                        await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });

                        if (item.record.linkType === 'hardlink') {
                            await fs.promises.link(item.resolvedTarget, linkPath);
                            this.manager.recordHardLink(linkPath, item.resolvedTarget);
                        } else {
                            const type: 'junction' | 'dir' | 'file' =
                                process.platform === 'win32' && item.record.isDirectory ? 'junction'
                                    : item.record.isDirectory ? 'dir'
                                    : 'file';
                            await fs.promises.symlink(item.resolvedTarget, linkPath, type);
                        }
                        created++;
                    } catch (err) {
                        failed++;
                        errors.push(`${path.basename(linkPath)}: ${(err as Error).message}`);
                    }
                }
            }
        );

        if (failed === 0) {
            vscode.window.showInformationMessage(
                `Imported ${created} link${created !== 1 ? 's' : ''} successfully.`
            );
        } else {
            const choice = await vscode.window.showWarningMessage(
                `Imported ${created} link${created !== 1 ? 's' : ''}, ${failed} failed.`,
                'Show Errors'
            );
            if (choice === 'Show Errors') {
                const channel = vscode.window.createOutputChannel('SymLynx');
                channel.appendLine('Import errors:');
                errors.forEach(e => channel.appendLine(`  • ${e}`));
                channel.show();
            }
        }

        return created > 0;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private resolveTarget(record: ExportRecord, sourceRoot: string, remapRoot: string | null): string {
        if (remapRoot && record.targetRelativeToWorkspace) {
            return path.join(remapRoot, record.targetRelativeToWorkspace.replace(/\//g, path.sep));
        }
        return record.targetAbsolute.replace(/\//g, path.sep);
    }

    private pathExists(p: string): boolean {
        try { fs.lstatSync(p); return true; } catch { return false; }
    }
}
