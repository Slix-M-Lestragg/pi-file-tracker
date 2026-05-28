# @slix/pi-file-tracker

A persistent widget for the [pi coding agent](https://pi.dev) that sits above the text input and lists every file the agent has touched during the session — created, edited, or deleted — updated in real time.

![pi-file-tracker widget showing edited files with diff stats](./screenshot.png)

## Install

```
pi install npm:@slix/pi-file-tracker
```

Activates automatically — no configuration needed. Run `/reload` if pi is already open.

## What it shows

```
── Edited files (3) ──────────────────────────────────────────────
   | app.ts | src ✎3                                    +42 -7
 ✚ | new.json | config ✎1                               +12 -0
 ✖ | old-utils.ts | src
```

| Element | Meaning |
|---------|---------|
| `+N` (green) | Lines added across all edits to that file |
| `-N` (red) | Lines removed (always shown, `0` if none) |
| `✎N` (yellow) | Number of separate edit/write operations |
| ` ✚ ` (green) | File was created new during this session |
| ` ✖ ` (red) | File was deleted during this session |

Stats are right-aligned to the terminal edge. Filenames are shown bold, followed by the parent directory path.

## What gets tracked

Every file change the agent makes is captured, regardless of how it happens:

| Source | What's detected |
|--------|----------------|
| `edit` tool | Exact diff via pi's `EditToolDetails` |
| `write` tool | LCS diff against the previous file content |
| `bash` tool | Full filesystem snapshot diff — catches `sed -i`, `cp`, `mv`, `touch`, output redirections, `rm`, and anything else |

The bash tracking takes a directory snapshot before and after every shell command, so no file operation is missed.

## Commands

| Command | Effect |
|---------|--------|
| `/file-tracker` | Toggle the widget on/off |
| `/file-tracker chars` | Switch between line-count and character-count display |
| `/file-tracker clear` | Reset the tracked files list |

## Session persistence

State is saved to the session file after every change via `pi.appendEntry`, so the file list survives restarts and session resumes. It is also branch-aware: navigating the session tree with `/tree` rebuilds the list from the active branch, so the widget always reflects only the files touched on the current conversation path.
