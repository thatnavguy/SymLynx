export type LinkType = 'symlink' | 'hardlink';

export interface LinkInfo {
    linkPath: string;
    targetPath: string;      // for hardlinks: the original path when created
    targetAbsolute: string;
    isDirectory: boolean;
    isBroken: boolean;
    workspaceRoot: string;
    linkType: LinkType;
}

export interface HardLinkRecord {
    linkPath: string;
    targetPath: string;
}
