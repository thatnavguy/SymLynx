import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HardLinkRecord, LinkInfo, LinkType } from './types';

const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'out', 'dist', 'build',
    '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'env', '.tox',
    'coverage', '.nyc_output', '.cache', 'tmp', 'temp',
]);

const HARDLINKS_KEY = 'symlynx.hardlinks';

function sameDrive(a: string, b: string): boolean {
    return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

function symlinkType(isDirectory: boolean): 'junction' | 'dir' | 'file' {
    if (process.platform === 'win32' && isDirectory) {
        return 'junction';
    }
    return isDirectory ? 'dir' : 'file';
}

async function targetIsDirectory(targetPath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(targetPath)).isDirectory();
    } catch {
        return false;
    }
}

export class SymlinkManager {
    constructor(private readonly context: vscode.ExtensionContext) {}

    // ── Public: create ──────────────────────────────────────────────────────

    async createSymlinkHere(folderUri?: vscode.Uri): Promise<string | undefined> {
        let destFolder: string;
        if (folderUri) {
            destFolder = folderUri.fsPath;
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                title: 'Select folder to create link in', openLabel: 'Select Folder',
            });
            if (!picked?.length) { return; }
            destFolder = picked[0].fsPath;
        }

        const targetPicked = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: true, canSelectMany: false,
            title: 'Select symlink target (file or folder)', openLabel: 'Set as Target',
        });
        if (!targetPicked?.length) { return; }
        return this.finalizeCreate(destFolder, targetPicked[0].fsPath);
    }

    async createSymlinkTo(targetUri?: vscode.Uri): Promise<string | undefined> {
        let targetPath: string;
        if (targetUri) {
            targetPath = targetUri.fsPath;
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectFolders: true, canSelectMany: false,
                title: 'Select symlink target (file or folder)', openLabel: 'Set as Target',
            });
            if (!picked?.length) { return; }
            targetPath = picked[0].fsPath;
        }

        const destPicked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'Select folder to create link in', openLabel: 'Create Link Here',
        });
        if (!destPicked?.length) { return; }
        return this.finalizeCreate(destPicked[0].fsPath, targetPath);
    }

    // ── Public: delete ──────────────────────────────────────────────────────

    async deleteLink(linkPath: string, linkType: LinkType): Promise<boolean> {
        const name = path.basename(linkPath);
        const label = linkType === 'hardlink' ? 'hard link' : 'symlink';
        const detail = linkType === 'hardlink'
            ? 'The original file will not be affected — only this link will be removed.'
            : 'The target will not be affected.';

        const choice = await vscode.window.showWarningMessage(
            `Delete ${label} "${name}"? ${detail}`,
            { modal: true },
            'Delete',
        );
        if (choice !== 'Delete') { return false; }

        try {
            await fs.promises.unlink(linkPath);
            if (linkType === 'hardlink') {
                this.removeHardLinkRecord(linkPath);
            }
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete ${label}: ${(err as Error).message}`);
            return false;
        }
    }

    // ── Public: scan ────────────────────────────────────────────────────────

    async getAllLinks(rootPath: string): Promise<LinkInfo[]> {
        const [symlinks, hardlinks] = await Promise.all([
            this.scanForSymlinks(rootPath),
            this.getHardLinks(rootPath),
        ]);
        return [...symlinks, ...hardlinks].sort((a, b) => a.linkPath.localeCompare(b.linkPath));
    }

    // ── Private: create helpers ─────────────────────────────────────────────

    private async finalizeCreate(destFolder: string, targetPath: string): Promise<string | undefined> {
        const defaultName = path.basename(targetPath);
        const symlinkName = await vscode.window.showInputBox({
            prompt: 'Link name',
            value: defaultName,
            validateInput: v => {
                if (!v?.trim()) { return 'Name cannot be empty'; }
                if (v.includes('/') || v.includes('\\')) { return 'Name cannot contain path separators'; }
                return null;
            },
        });
        if (!symlinkName) { return; }

        const linkPath = path.join(destFolder, symlinkName);

        try {
            await fs.promises.lstat(linkPath);
            vscode.window.showErrorMessage(`"${symlinkName}" already exists at that location.`);
            return;
        } catch { /* expected — path does not exist yet */ }

        const isDir = await targetIsDirectory(targetPath);
        const type = symlinkType(isDir);

        try {
            await fs.promises.symlink(targetPath, linkPath, type);
            vscode.window.showInformationMessage(`Symlink created: ${symlinkName} → ${targetPath}`);
            return linkPath;
        } catch (err) {
            return this.handleSymlinkError(err as NodeJS.ErrnoException, targetPath, linkPath, isDir);
        }
    }

    private async handleSymlinkError(
        err: NodeJS.ErrnoException,
        targetPath: string,
        linkPath: string,
        isDir: boolean,
    ): Promise<string | undefined> {
        if (err.code !== 'EPERM' || process.platform !== 'win32') {
            vscode.window.showErrorMessage(`Failed to create symlink: ${err.message}`);
            return;
        }

        if (isDir) {
            // Directories use junctions which never need elevation — this is unexpected
            vscode.window.showErrorMessage(
                `Failed to create directory junction: ${err.message}. Try running VS Code as administrator.`
            );
            return;
        }

        // File symlink on Windows — offer hard link if on same drive
        if (sameDrive(targetPath, linkPath)) {
            const choice = await vscode.window.showErrorMessage(
                'File symlinks require Developer Mode on Windows. ' +
                'Since both files are on the same drive, you can use a hard link instead — ' +
                'a second filename pointing to the exact same file data.',
                'Create Hard Link',
                'Enable Developer Mode',
                'Cancel',
            );
            if (choice === 'Create Hard Link') {
                return this.createHardLink(targetPath, linkPath);
            }
            if (choice === 'Enable Developer Mode') {
                vscode.env.openExternal(vscode.Uri.parse('ms-settings:developers'));
            }
        } else {
            vscode.window.showErrorMessage(
                'File symlinks require Developer Mode on Windows. ' +
                'Hard links are not an option here because the target is on a different drive. ' +
                'Enable Developer Mode or move both files to the same drive.',
                'Enable Developer Mode',
            ).then(sel => {
                if (sel === 'Enable Developer Mode') {
                    vscode.env.openExternal(vscode.Uri.parse('ms-settings:developers'));
                }
            });
        }
        return;
    }

    private async createHardLink(targetPath: string, linkPath: string): Promise<string | undefined> {
        try {
            await fs.promises.link(targetPath, linkPath);
            this.addHardLinkRecord({ linkPath, targetPath });
            vscode.window.showInformationMessage(
                `Hard link created: ${path.basename(linkPath)} → ${targetPath}`
            );
            return linkPath;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create hard link: ${(err as Error).message}`);
            return;
        }
    }

    // ── Private: scan ───────────────────────────────────────────────────────

    private async scanForSymlinks(rootPath: string): Promise<LinkInfo[]> {
        const results: LinkInfo[] = [];
        await this.scanDir(rootPath, rootPath, results);
        return results;
    }

    private async scanDir(dirPath: string, rootPath: string, out: LinkInfo[]): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch {
            return;
        }

        await Promise.all(entries.map(async entry => {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isSymbolicLink()) {
                let targetPath = '';
                let targetAbsolute = '';
                let isBroken = false;
                let isDirectory = false;

                try {
                    targetPath = await fs.promises.readlink(fullPath);
                    targetAbsolute = path.isAbsolute(targetPath)
                        ? targetPath
                        : path.resolve(dirPath, targetPath);
                    const stat = await fs.promises.stat(fullPath);
                    isDirectory = stat.isDirectory();
                } catch {
                    isBroken = true;
                    if (!targetPath) { targetPath = '(unreadable)'; }
                    if (!targetAbsolute) { targetAbsolute = targetPath; }
                }

                out.push({ linkPath: fullPath, targetPath, targetAbsolute, isDirectory, isBroken, workspaceRoot: rootPath, linkType: 'symlink' });
            } else if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
                await this.scanDir(fullPath, rootPath, out);
            }
        }));
    }

    private async getHardLinks(workspaceRoot: string): Promise<LinkInfo[]> {
        const records = this.getHardLinkRecords().filter(r =>
            r.linkPath.toLowerCase().startsWith(workspaceRoot.toLowerCase())
        );

        return Promise.all(records.map(async record => {
            let isBroken = false;
            try {
                await fs.promises.access(record.linkPath);
            } catch {
                isBroken = true;
            }
            return {
                linkPath: record.linkPath,
                targetPath: record.targetPath,
                targetAbsolute: record.targetPath,
                isDirectory: false,
                isBroken,
                workspaceRoot,
                linkType: 'hardlink' as LinkType,
            };
        }));
    }

    // ── Private: storage ────────────────────────────────────────────────────

    private getHardLinkRecords(): HardLinkRecord[] {
        return this.context.workspaceState.get<HardLinkRecord[]>(HARDLINKS_KEY, []);
    }

    recordHardLink(linkPath: string, targetPath: string): void {
        this.addHardLinkRecord({ linkPath, targetPath });
    }

    private addHardLinkRecord(record: HardLinkRecord): void {
        const records = this.getHardLinkRecords();
        if (!records.some(r => r.linkPath === record.linkPath)) {
            records.push(record);
            this.context.workspaceState.update(HARDLINKS_KEY, records);
        }
    }

    private removeHardLinkRecord(linkPath: string): void {
        const records = this.getHardLinkRecords().filter(r => r.linkPath !== linkPath);
        this.context.workspaceState.update(HARDLINKS_KEY, records);
    }

    private updateHardLinkPath(oldPath: string, newPath: string): void {
        const records = this.getHardLinkRecords();
        const record = records.find(r => r.linkPath === oldPath);
        if (record) {
            record.linkPath = newPath;
            this.context.workspaceState.update(HARDLINKS_KEY, records);
        }
    }

    // ── Public: fix & rename ────────────────────────────────────────────────

    async fixBrokenTarget(linkPath: string): Promise<string | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: false,
            title: `Select new target for "${path.basename(linkPath)}"`,
            openLabel: 'Set as New Target',
        });
        if (!picked?.length) { return; }
        const newTarget = picked[0].fsPath;

        try {
            await fs.promises.unlink(linkPath);
            const isDir = await targetIsDirectory(newTarget);
            await fs.promises.symlink(newTarget, linkPath, symlinkType(isDir));
            vscode.window.showInformationMessage(`Fixed: ${path.basename(linkPath)} → ${newTarget}`);
            return linkPath;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fix symlink: ${(err as Error).message}`);
            return;
        }
    }

    async renameLink(linkPath: string, linkType: LinkType): Promise<string | undefined> {
        const oldName = path.basename(linkPath);
        const newName = await vscode.window.showInputBox({
            prompt: 'New name',
            value: oldName,
            validateInput: v => {
                if (!v?.trim()) { return 'Name cannot be empty'; }
                if (v.includes('/') || v.includes('\\')) { return 'Name cannot contain path separators'; }
                if (v === oldName) { return { message: 'Name is unchanged', severity: vscode.InputBoxValidationSeverity.Warning }; }
                return null;
            },
        });
        if (!newName || newName === oldName) { return; }

        const newPath = path.join(path.dirname(linkPath), newName);

        try {
            await fs.promises.lstat(newPath);
            vscode.window.showErrorMessage(`"${newName}" already exists.`);
            return;
        } catch { /* good — path is free */ }

        try {
            await fs.promises.rename(linkPath, newPath);
            if (linkType === 'hardlink') {
                this.updateHardLinkPath(linkPath, newPath);
            }
            return newPath;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to rename: ${(err as Error).message}`);
            return;
        }
    }
}
