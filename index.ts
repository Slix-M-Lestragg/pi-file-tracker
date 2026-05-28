/**
 * File Tracker Extension
 *
 * Displays a persistent widget above the text input listing every file the
 * agent has edited during the current session, along with per-file diff stats.
 *
 * Tracked tools : edit, write
 * Widget shows  : relative path  |  +lines / -lines  |  edit count  |  ✦ new-file marker
 * Char stats    : tracked internally (toggle to show with /file-tracker chars)
 *
 * Commands:
 *   /file-tracker          – toggle widget visibility
 *   /file-tracker chars    – toggle chars vs lines display mode
 *   /file-tracker clear    – clear tracked files from current session
 *
 * Placement: ~/.pi/agent/extensions/file-tracker/index.ts
 */

import type {
	EditToolDetails,
	ExtensionAPI,
	ExtensionContext,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// ─── Data model ─────────────────────────────────────────────────────────────

interface FileStats {
	/** Absolute path to the file */
	path: string;
	/** Net lines added across all edits */
	linesAdded: number;
	/** Net lines removed across all edits */
	linesRemoved: number;
	/** Net characters added across all edits */
	charsAdded: number;
	/** Net characters removed across all edits */
	charsRemoved: number;
	/** How many times this file has been edited/written */
	editCount: number;
	/** Lifecycle status of the file */
	status: "edited" | "created" | "deleted";
}

interface PersistedState {
	files: FileStats[];
	enabled: boolean;
	showChars: boolean;
}

// ─── Diff helpers ────────────────────────────────────────────────────────────

/** Parse added/removed counts from a unified-diff string (edit tool format). */
function parseDiffStats(diff: string): Pick<FileStats, "linesAdded" | "linesRemoved" | "charsAdded" | "charsRemoved"> {
	let linesAdded = 0,
		linesRemoved = 0,
		charsAdded = 0,
		charsRemoved = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			linesAdded++;
			charsAdded += Math.max(0, line.length - 1); // drop the '+' prefix char
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			linesRemoved++;
			charsRemoved += Math.max(0, line.length - 1);
		}
	}
	return { linesAdded, linesRemoved, charsAdded, charsRemoved };
}

/**
 * Compute a line-level diff between two text blobs.
 * Uses LCS for files where `oldLines * newLines <= 300 000` (≈ ~550 × 550 lines).
 * Falls back to a simpler delta count for very large files.
 */
function diffLines(
	oldContent: string,
	newContent: string,
): Pick<FileStats, "linesAdded" | "linesRemoved" | "charsAdded" | "charsRemoved"> {
	const a = oldContent.split("\n");
	const b = newContent.split("\n");

	if (a.length * b.length > 300_000) {
		// Simple fallback for huge files — avoids O(N²) memory
		return {
			linesAdded: b.length,
			linesRemoved: a.length,
			charsAdded: newContent.length,
			charsRemoved: oldContent.length,
		};
	}

	const m = a.length;
	const n = b.length;
	// Flat 1-D DP table to avoid 2-D array allocation
	const dp = new Uint32Array((m + 1) * (n + 1));
	const idx = (i: number, j: number) => i * (n + 1) + j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[idx(i, j)] =
				a[i - 1] === b[j - 1]
					? dp[idx(i - 1, j - 1)] + 1
					: Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
		}
	}

	// Backtrack through the LCS table to count additions / removals
	let linesAdded = 0,
		linesRemoved = 0,
		charsAdded = 0,
		charsRemoved = 0;
	let i = m,
		j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[idx(i, j - 1)] >= dp[idx(i - 1, j)])) {
			charsAdded += b[j - 1]!.length;
			linesAdded++;
			j--;
		} else {
			charsRemoved += a[i - 1]!.length;
			linesRemoved++;
			i--;
		}
	}

	return { linesAdded, linesRemoved, charsAdded, charsRemoved };
}

// ─── Filesystem snapshot helpers ───────────────────────────────────────────

/** path → { mtime, size } for every non-ignored file under a directory */
type FsSnapshot = Map<string, { mtime: number; size: number }>;

const SNAPSHOT_SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", "__pycache__"]);

async function takeSnapshot(dir: string): Promise<FsSnapshot> {
	const snap: FsSnapshot = new Map();
	let total = 0;
	async function walk(d: string): Promise<void> {
		if (total > 20_000) return;
		let entries;
		try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (SNAPSHOT_SKIP.has(e.name)) continue;
			const full = `${d}/${e.name}`;
			if (e.isDirectory()) { await walk(full); }
			else if (e.isFile()) {
				try { const s = await stat(full); snap.set(full, { mtime: s.mtimeMs, size: s.size }); total++; }
				catch { /* ignore permission errors */ }
			}
		}
	}
	await walk(dir);
	return snap;
}

function diffSnapshots(
	before: FsSnapshot,
	after: FsSnapshot,
): { created: string[]; modified: string[]; deleted: string[] } {
	const created: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const [p, a] of after) {
		const b = before.get(p);
		if (!b) created.push(p);
		else if (a.mtime !== b.mtime || a.size !== b.size) modified.push(p);
	}
	for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
	return { created, modified, deleted };
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function toRelativePath(absPath: string, cwd: string): string {
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function toAbsPath(filePath: string, cwd: string): string {
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function fileTrackerExtension(pi: ExtensionAPI): void {
	/** Canonical store keyed by absolute path */
	const fileMap = new Map<string, FileStats>();
	/** Whether the widget is visible */
	let widgetEnabled = true;
	/** Whether to display character counts instead of line counts */
	let showChars = false;
	/** CWD for the current session */
	let cwd = process.cwd();

	/**
	 * Stores pre-bash filesystem snapshots + old content of already-tracked files.
	 * Key: toolCallId
	 */
	interface BashPre { snap: FsSnapshot; tracked: Map<string, string> }
	const pendingBashPre = new Map<string, BashPre>();

	/**
	 * Stores old file content before a `write` executes.
	 * Key: toolCallId  Value: old file content (null = file was new)
	 */
	const pendingWriteOldContent = new Map<string, string | null>();

	// ── Persistence helpers ──────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("file-tracker", {
			files: [...fileMap.values()],
			enabled: widgetEnabled,
			showChars,
		} satisfies PersistedState);
	}

	function restoreFromSession(ctx: ExtensionContext): void {
		fileMap.clear();
		// Walk the current branch; take the LAST file-tracker custom entry
		const entries = ctx.sessionManager.getBranch();
		let lastState: PersistedState | undefined;
		for (const entry of entries) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === "file-tracker") {
				lastState = (entry as { data?: PersistedState }).data;
			}
		}
		if (lastState) {
			widgetEnabled = lastState.enabled ?? true;
			showChars = lastState.showChars ?? false;
			for (const f of lastState.files ?? []) {
				// Migrate old sessions that stored isNew:boolean instead of status
				if (!("status" in f)) {
					(f as FileStats).status = (f as unknown as { isNew: boolean }).isNew ? "created" : "edited";
				}
				fileMap.set(f.path, f);
			}
		}
	}

	// ── Widget rendering ─────────────────────────────────────────────────────

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const files = [...fileMap.values()];

		if (!widgetEnabled || files.length === 0) {
			ctx.ui.setWidget("file-tracker", undefined);
			return;
		}

		// Snapshot the state so the closure is stable
		const snapshot = [...files];
		const cwdSnap = cwd;
		const useChars = showChars;

		ctx.ui.setWidget("file-tracker", (_tui, theme) => {
			let cachedLines: string[] | undefined;
			let cachedWidth: number | undefined;

			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;

					const lines: string[] = [];

					// ── Header ─────────────────────────────────────────────
					const title = ` Edited files (${snapshot.length}) `;
					const titleColored = theme.fg("accent", title);
					const borderLen = Math.max(0, width - visibleWidth(title));
					const borderLeft = theme.fg("borderMuted", "─".repeat(2));
					const borderRight = theme.fg("borderMuted", "─".repeat(Math.max(0, borderLen - 2)));
					lines.push(truncateToWidth(`${borderLeft}${titleColored}${borderRight}`, width));

					// ── File rows ──────────────────────────────────────────
					for (const f of snapshot) {
						const relPath = toRelativePath(f.path, cwdSnap);

						if (f.status === "deleted") {
							const icon = theme.fg("error", "⨵ ");
							lines.push(truncateToWidth(`${icon}${theme.fg("error", relPath)}`, width));
							continue;
						}

						const icon = f.status === "created" ? theme.fg("success", "⨮ ") : "  ";
						const pathPart = f.status === "created"
							? theme.fg("success", relPath)
							: theme.fg("accent", relPath);

						// Stat display (lines or chars)
						const added = useChars ? f.charsAdded : f.linesAdded;
						const removed = useChars ? f.charsRemoved : f.linesRemoved;
						const unit = useChars ? "c" : "";

						const statParts: string[] = [];
						if (added > 0) statParts.push(theme.fg("success", `+${added}${unit}`));
						if (removed > 0) statParts.push(theme.fg("error", `-${removed}${unit}`));
						const statsStr = statParts.length > 0 ? statParts.join(theme.fg("dim", " ")) : theme.fg("dim", "~");

						const editBadge = theme.fg("warning", `✎${f.editCount}`);

						lines.push(truncateToWidth(`${icon}${pathPart}  ${statsStr}  ${editBadge}`, width));
					}

					cachedLines = lines;
					cachedWidth = width;
					return lines;
				},

				invalidate(): void {
					cachedLines = undefined;
					cachedWidth = undefined;
				},
			};
		});
	}

	// ── File-stats accumulator ───────────────────────────────────────────────

	function accumulateStats(
		absPath: string,
		delta: Pick<FileStats, "linesAdded" | "linesRemoved" | "charsAdded" | "charsRemoved">,
		status: "edited" | "created",
	): void {
		const existing = fileMap.get(absPath);
		if (existing) {
			existing.linesAdded += delta.linesAdded;
			existing.linesRemoved += delta.linesRemoved;
			existing.charsAdded += delta.charsAdded;
			existing.charsRemoved += delta.charsRemoved;
			existing.editCount++;
			// If a deleted file is re-created, update its status
			if (existing.status === "deleted") existing.status = status;
		} else {
			fileMap.set(absPath, {
				path: absPath,
				linesAdded: delta.linesAdded,
				linesRemoved: delta.linesRemoved,
				charsAdded: delta.charsAdded,
				charsRemoved: delta.charsRemoved,
				editCount: 1,
				status,
			});
		}
	}

	function markDeleted(absPath: string, ctx: ExtensionContext): void {
		const existing = fileMap.get(absPath);
		if (existing) {
			existing.status = "deleted";
		} else {
			fileMap.set(absPath, {
				path: absPath, linesAdded: 0, linesRemoved: 0,
				charsAdded: 0, charsRemoved: 0, editCount: 0, status: "deleted",
			});
		}
		persistState();
		updateWidget(ctx);
	}

	// ── Events ───────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		restoreFromSession(ctx);
		updateWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Branch navigation: rebuild stats from the new active branch
		cwd = ctx.cwd;
		restoreFromSession(ctx);
		updateWidget(ctx);
	});

	/** Snapshot the filesystem before bash; capture current content of tracked files for accurate diffs */
	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "bash") {
			const snap = await takeSnapshot(cwd);
			const tracked = new Map<string, string>();
			for (const absPath of fileMap.keys()) {
				try { tracked.set(absPath, await readFile(absPath, "utf-8")); } catch { /* already gone */ }
			}
			pendingBashPre.set(event.toolCallId, { snap, tracked });
			return;
		}

		/** Capture existing write-target content for diff */
		if (!isToolCallEventType("write", event)) return;
		const absPath = toAbsPath((event as WriteToolCallEvent).input.path, cwd);
		try {
			const content = await readFile(absPath, "utf-8");
			pendingWriteOldContent.set(event.toolCallId, content);
		} catch {
			// File doesn't exist yet → it's a new file
			pendingWriteOldContent.set(event.toolCallId, null);
		}
	});

	/** Process completed tool results and update file stats */
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// ── edit tool ────────────────────────────────────────────────────────
		if (isEditToolResult(event)) {
			const details = event.details as EditToolDetails | undefined;
			if (!details?.diff) return;

			const absPath = toAbsPath(event.input.path as string, cwd);
			accumulateStats(absPath, parseDiffStats(details.diff), "edited");
			persistState();
			updateWidget(ctx);
			return;
		}

		// ── write tool ───────────────────────────────────────────────────────
		if (isWriteToolResult(event)) {
			const input = event.input as { path: string; content: string };
			const absPath = toAbsPath(input.path, cwd);
			const newContent = input.content;
			const oldContent = pendingWriteOldContent.get(event.toolCallId);
			pendingWriteOldContent.delete(event.toolCallId);

			const isNew = oldContent === null || oldContent === undefined;
			const delta = isNew
				? {
						linesAdded: newContent.split("\n").length,
						linesRemoved: 0,
						charsAdded: newContent.length,
						charsRemoved: 0,
					}
				: diffLines(oldContent as string, newContent);

			accumulateStats(absPath, delta, isNew ? "created" : "edited");
			persistState();
			updateWidget(ctx);
		}

		// ── bash: filesystem snapshot diff ─────────────────────────────────────
		if (event.toolName === "bash") {
			const pre = pendingBashPre.get(event.toolCallId);
			pendingBashPre.delete(event.toolCallId);
			if (pre) {
				const after = await takeSnapshot(cwd);
				const { created, modified, deleted } = diffSnapshots(pre.snap, after);
				let dirty = false;
				for (const p of created) {
					try {
						const content = await readFile(p, "utf-8");
						accumulateStats(p, { linesAdded: content.split("\n").length, linesRemoved: 0, charsAdded: content.length, charsRemoved: 0 }, "created");
						dirty = true;
					} catch { /* binary or unreadable — skip */ }
				}
				for (const p of modified) {
					try {
						const newContent = await readFile(p, "utf-8");
						const oldContent = pre.tracked.get(p) ?? "";
						accumulateStats(p, diffLines(oldContent, newContent), "edited");
						dirty = true;
					} catch { /* binary — skip */ }
				}
				for (const p of deleted) { markDeleted(p, ctx); dirty = true; }
				if (dirty) { persistState(); updateWidget(ctx); }
			}
			return;
		}
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("file-tracker", {
		description: "Toggle edited-files widget  |  args: chars | clear",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			if (arg === "chars") {
				showChars = !showChars;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(`File tracker: showing ${showChars ? "character" : "line"} stats`, "info");
				return;
			}

			if (arg === "clear") {
				fileMap.clear();
				persistState();
				updateWidget(ctx);
				ctx.ui.notify("File tracker: cleared", "info");
				return;
			}

			// Default: toggle visibility
			widgetEnabled = !widgetEnabled;
			persistState();
			updateWidget(ctx);
			ctx.ui.notify(`File tracker widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
