# Changelog

All notable changes to SymLynx are documented here.

## [0.0.1] — 2026-04-28

### Added

**Core link management**
- Create symlinks via right-click context menu in the Explorer — two flows:
  - *Create Symlink Here* — right-click a folder, then pick the target
  - *Create Symlink to This* — right-click any file or folder, then pick the destination
- Delete symlinks and hard links with a confirmation prompt
- Rename any link in-place (no delete and recreate)
- Fix broken symlinks — pick a new target without changing the link's location

**Symbolic Links panel**
- Dedicated panel in the Explorer sidebar listing all symlinks and hard links in the workspace
- Symlinks shown with blue arrow icon; hard links with orange link icon; broken symlinks with yellow warning icon
- Inline action buttons per item: Reveal Target / Reveal Original, Fix (broken only), Rename, Delete
- Right-click context menu with full navigation and management options
- Panel auto-refreshes when files are created or deleted (800 ms debounce)
- Panel message shows link counts and scan status

**Status bar**
- Live badge in the status bar showing total link count
- Turns yellow with a broken-link count when broken symlinks are detected
- Click to focus the Symbolic Links panel

**Windows support**
- Directory symlinks created as junctions (no elevation or Developer Mode required)
- File symlinks fall back to hard links when Developer Mode is unavailable and both files are on the same drive
- Clear error messages with a direct link to `ms-settings:developers` when elevation is required

**Export / Import**
- Export all links in a workspace to a `.symlynx` JSON file
- Import links from a `.symlynx` file into any workspace
- On import: detects targets that lived inside the source workspace and offers to remap them to the current workspace
- Checklist preview before import — pre-deselects conflicts and uncreatable items
- Import errors surfaced in a dedicated Output Channel
