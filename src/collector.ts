import { App, TFile, getAllTags } from "obsidian";
import type { HighlightInboxSettings } from "./settings";
import type { Highlight, HighlightCategory, HighlightSource } from "./types";

const CATEGORIES: ReadonlySet<HighlightCategory> = new Set([
	"books",
	"articles",
	"tweets",
	"podcasts",
	"videos",
]);

/**
 * Gathers highlight sources from the vault. Pure collection — no LLM calls.
 * A note qualifies if it lives under the configured folder OR carries the
 * configured tag. The body is parsed into individual highlights defensively,
 * since Readwise/clipper templates vary widely.
 */
export class HighlightCollector {
	private readonly app: App;
	private readonly settings: HighlightInboxSettings;

	constructor(app: App, settings: HighlightInboxSettings) {
		this.app = app;
		this.settings = settings;
	}

	async collect(): Promise<HighlightSource[]> {
		const sources: HighlightSource[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isSource(file)) {
				continue;
			}
			sources.push(await this.toSource(file));
		}

		return sources;
	}

	private isSource(file: TFile): boolean {
		return this.matchesFolder(file) || this.matchesTag(file);
	}

	private matchesFolder(file: TFile): boolean {
		const folder = this.settings.sourceFolder.trim().replace(/\/+$/, "");
		if (folder === "") {
			return false;
		}
		return file.path === folder || file.path.startsWith(`${folder}/`);
	}

	private matchesTag(file: TFile): boolean {
		const wanted = this.normalizeTag(this.settings.sourceTag);
		if (wanted === "") {
			return false;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			return false;
		}
		const tags = getAllTags(cache) ?? [];
		return tags.some((tag) => this.normalizeTag(tag) === wanted);
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, "").toLowerCase();
	}

	/**
	 * Map a vault file to a HighlightSource. Frontmatter templates vary, so every
	 * field is optional and read defensively: the URL may live under "url" or
	 * "source", the date under "highlighted_date". The body is split into
	 * individual highlights.
	 */
	private async toSource(file: TFile): Promise<HighlightSource> {
		const frontmatter =
			this.app.metadataCache.getFileCache(file)?.frontmatter;

		const source: HighlightSource = {
			path: file.path,
			title: this.asString(frontmatter?.["title"]) ?? file.basename,
			mtime: file.stat.mtime,
			tags: this.readTags(frontmatter),
			highlights: [],
		};

		const category = this.asCategory(frontmatter?.["category"]);
		if (category !== undefined) {
			source.category = category;
		}

		const author = this.asString(frontmatter?.["author"]);
		if (author !== undefined) {
			source.author = author;
		}

		const url =
			this.asString(frontmatter?.["url"]) ??
			this.asString(frontmatter?.["source"]);
		if (url !== undefined) {
			source.url = url;
		}

		const highlightedDate = this.parseDate(frontmatter?.["highlighted_date"]);
		if (highlightedDate !== undefined) {
			source.highlightedDate = highlightedDate;
		}

		const raw = await this.app.vault.cachedRead(file);
		source.highlights = this.splitHighlights(raw);

		return source;
	}

	/**
	 * Split a source body into individual highlights. Readwise/clipper templates
	 * vary, so several markers are tried in turn, FALLING BACK to the whole body
	 * as a single highlight when none match:
	 *   1. block-id lines ("... ^rw-abc123"),
	 *   2. "> [!QUOTE]" callout blocks,
	 *   3. plain bullets ("- ...").
	 * The first marker that yields highlights wins, so a body is never split two
	 * different ways.
	 */
	private splitHighlights(raw: string): Highlight[] {
		const body = this.stripFrontmatter(raw).trim();
		if (body === "") {
			return [];
		}

		const byBlockId = this.fromBlockIds(body);
		if (byBlockId.length > 0) {
			return byBlockId;
		}

		const byCallout = this.fromCallouts(body);
		if (byCallout.length > 0) {
			return byCallout;
		}

		const byBullet = this.fromBullets(body);
		if (byBullet.length > 0) {
			return byBullet;
		}

		// Fallback: no recognizable markers — treat the whole body as one block.
		// Still strip per-line markers (so any stray "[!QUOTE]"/"^block-id" can
		// never leak through), but keep paragraph breaks intact for plain prose.
		const whole = body
			.split("\n")
			.map((line) => this.stripLineMarkers(line))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return whole === "" ? [] : [{ text: whole }];
	}

	/** Drop a leading YAML frontmatter block, if present. */
	private stripFrontmatter(raw: string): string {
		return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	}

	/**
	 * Split on markdown block-id markers ("... ^rw-abc123"). Each marker ends a
	 * highlight; the lines accumulated before it (with bullet/quote prefixes
	 * stripped) form its text. Returns [] when the body carries no block ids.
	 */
	private fromBlockIds(body: string): Highlight[] {
		const blockIdRe = /\s*\^([A-Za-z0-9][\w-]*)\s*$/;
		const highlights: Highlight[] = [];
		let buffer: string[] = [];
		let found = false;

		for (const line of body.split("\n")) {
			const match = line.match(blockIdRe);
			if (match) {
				found = true;
				buffer.push(line.replace(blockIdRe, ""));
				const text = this.cleanHighlightText(buffer.join("\n"));
				if (text !== "") {
					highlights.push({ text, blockId: match[1] });
				}
				buffer = [];
			} else {
				buffer.push(line);
			}
		}

		if (!found) {
			return [];
		}

		// Trailing content after the last block id becomes a final highlight.
		const tail = this.cleanHighlightText(buffer.join("\n"));
		if (tail !== "") {
			highlights.push({ text: tail });
		}
		return highlights;
	}

	/**
	 * Split on "> [!QUOTE]" callout blocks. Each callout's quoted lines (the
	 * marker line plus following "> " lines) form one highlight. Returns [] when
	 * the body has no quote callouts.
	 */
	private fromCallouts(body: string): Highlight[] {
		const highlights: Highlight[] = [];
		let current: string[] | null = null;

		const flush = () => {
			if (current !== null) {
				const text = this.cleanHighlightText(current.join("\n"));
				if (text !== "") {
					highlights.push({ text });
				}
				current = null;
			}
		};

		for (const line of body.split("\n")) {
			if (/^\s*>\s*\[!quote\]/i.test(line)) {
				flush();
				// Keep the marker line; cleanHighlightText strips the "[!QUOTE]"
				// tag itself and preserves any quoted text on the same line.
				current = [line];
			} else if (current !== null && /^\s*>/.test(line)) {
				current.push(line);
			} else {
				flush();
			}
		}
		flush();

		return highlights;
	}

	/**
	 * Split on plain bullets ("- ", "* ", "+ "). Each bullet plus its following
	 * wrapped/indented continuation lines forms ONE highlight, ending at the next
	 * bullet, a blank line, or a callout marker. An indented "Note: ..." bullet
	 * attaches to the previous highlight instead. Returns [] when the body has no
	 * bullets.
	 */
	private fromBullets(body: string): Highlight[] {
		const bulletRe = /^(\s*)[-*+]\s+(.*)$/;
		const highlights: Highlight[] = [];
		let current: { indent: number; lines: string[] } | null = null;

		const flush = () => {
			if (current === null) {
				return;
			}
			const text = this.cleanHighlightText(current.lines.join("\n"));
			// An indented "Note: ..." bullet annotates the previous highlight
			// rather than standing as its own. The "s" flag lets a note wrap.
			const noteMatch = text.match(/^note:\s*([\s\S]*)$/i);
			if (current.indent > 0 && noteMatch && highlights.length > 0) {
				highlights[highlights.length - 1].note = noteMatch[1].trim();
			} else if (text !== "") {
				highlights.push({ text });
			}
			current = null;
		};

		for (const line of body.split("\n")) {
			const match = line.match(bulletRe);
			if (match) {
				// A new bullet starts a new highlight.
				flush();
				current = { indent: match[1].length, lines: [match[2]] };
			} else if (
				current !== null &&
				line.trim() !== "" &&
				!/^\s*>/.test(line)
			) {
				// A non-bullet, non-blank, non-callout line continues this bullet.
				current.lines.push(line);
			} else {
				// Blank line or callout marker ends the current highlight.
				flush();
			}
		}
		flush();

		return highlights;
	}

	/**
	 * Strip every leading/trailing markdown marker from ONE line. Removes, in
	 * order: the "> " blockquote/callout quote prefix, a callout-type marker
	 * ("[!QUOTE]", "[!quote]", any "[!TYPE]" with optional +/- fold), a bullet
	 * marker, and a trailing "^block-id" (e.g. "^rw-fm003"). The callout-marker
	 * and block-id strips run independent of the quote prefix, so a bare
	 * "[!QUOTE]" line (no ">") and a trailing block id are both removed whether or
	 * not a ">" was present. A line that was only a marker collapses to "".
	 */
	private stripLineMarkers(line: string): string {
		return line
			.replace(/^\s*>\s?/, "")
			.replace(/^\s*\[![^\]]*\][-+]?\s*/, "")
			.replace(/^\s*[-*+]\s+/, "")
			.replace(/\s*\^[A-Za-z0-9][\w-]*\s*$/, "")
			.trim();
	}

	/**
	 * Clean a highlight made of one or more lines: strip per-line markers and drop
	 * lines that were only markers (so "> [!QUOTE]" header lines never leak into
	 * the text), then collapse to non-empty lines.
	 */
	private cleanHighlightText(raw: string): string {
		return raw
			.split("\n")
			.map((line) => this.stripLineMarkers(line))
			.filter((line) => line !== "")
			.join("\n")
			.trim();
	}

	/** Read frontmatter "tags" as a normalized string array (array or CSV). */
	private readTags(frontmatter: Record<string, unknown> | undefined): string[] {
		const value = frontmatter?.["tags"];
		const raw = Array.isArray(value)
			? value
			: typeof value === "string"
				? value.split(",")
				: [];
		return raw
			.map((tag) => (typeof tag === "string" ? this.normalizeTag(tag) : ""))
			.filter((tag) => tag !== "");
	}

	/** Validate a frontmatter category against the known set, or undefined. */
	private asCategory(value: unknown): HighlightCategory | undefined {
		const raw = this.asString(value)?.toLowerCase();
		if (raw !== undefined && CATEGORIES.has(raw as HighlightCategory)) {
			return raw as HighlightCategory;
		}
		return undefined;
	}

	/**
	 * Normalize a frontmatter date to a YYYY-MM-DD string. Templates vary: accept
	 * ISO ("2026-06-13" or a full timestamp, sliced to the date) and European
	 * "DD.MM.YYYY" ("13.06.2026"). Pure string parsing — never `new Date()` — so
	 * locale and timezone can't shift the result. Anything unrecognized stays
	 * undefined rather than guessing.
	 */
	private parseDate(value: unknown): string | undefined {
		const raw = this.asString(value);
		if (raw === undefined) {
			return undefined;
		}

		const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
		if (iso) {
			return iso[1];
		}

		const european = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
		if (european) {
			return `${european[3]}-${european[2]}-${european[1]}`;
		}

		return undefined;
	}

	/** Non-empty trimmed string, or undefined for anything else. */
	private asString(value: unknown): string | undefined {
		if (typeof value !== "string") {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	}
}
