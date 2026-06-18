import type { LLMAdapter } from "./llm";
import type {
	HighlightSource,
	SourceExtraction,
	SynthesisCache,
	ThemeSynthesis,
} from "./types";

/** One new/changed source plus its prepared body (frontmatter stripped and
 * truncated by the caller — the engine never reads files). */
export interface SourceInput {
	source: HighlightSource;
	body: string;
}

export interface SyncResult {
	extracted: number;
	skipped: number;
	failed: number;
	themes: number;
	themesResynthesized: number;
}

/**
 * Owns the synthesis cache and answers cross-source queries.
 *
 * The engine is deliberately free of any Obsidian Plugin API: it never touches
 * the vault, settings, or saveData. It reads source bodies that were collected
 * and prepared for it, reaches the network only through the injected
 * {@link LLMAdapter}, and mutates the {@link SynthesisCache} it was constructed
 * with. Persisting that cache is the caller's job. It also never asks the clock
 * for "today" — the caller passes dates in — so the engine stays deterministic
 * and testable.
 *
 * Phase 2 skeleton: the cache mechanics (incremental skip-if-unchanged and the
 * djb2 signature) are real; the actual extraction, theme synthesis, and report
 * rendering are stubbed and arrive in Phase 3.
 */
export class SynthesisEngine {
	private readonly llm: LLMAdapter;
	private readonly cache: SynthesisCache;

	constructor(llm: LLMAdapter, cache: SynthesisCache) {
		this.llm = llm;
		this.cache = cache;
		// Backfill the theme map for caches persisted before theme synthesis
		// existed (the type marks it required, but an on-disk blob can predate it).
		if (this.cache.themeSyntheses === undefined) {
			this.cache.themeSyntheses = {};
		}
	}

	/**
	 * True when a source has no cached extraction, or its file changed since the
	 * cached one (mtime mismatch). The caller uses this to decide which bodies to
	 * read — unchanged sources never cost a BYOK API call twice.
	 */
	needsExtraction(source: HighlightSource): boolean {
		const existing = this.cache.extractions[source.path];
		return existing === undefined || existing.mtime !== source.mtime;
	}

	/**
	 * Extract every new/changed source, incrementally, then synthesize themes.
	 *
	 * `allSources` is the full current inbox (used to drop cache entries for
	 * sources that vanished from the vault); `inputs` is the subset that actually
	 * needs (re-)extraction, with bodies prepared by the caller. The cache is
	 * mutated in place; the caller persists it afterwards.
	 *
	 * Phase 2: extraction and synthesis are stubbed (no LLM calls yet), so this
	 * only maintains cache bookkeeping. Phase 3 fills in the LLM passes.
	 */
	async syncSources(
		allSources: HighlightSource[],
		inputs: SourceInput[],
		todayISO: string
	): Promise<SyncResult> {
		const result: SyncResult = {
			extracted: 0,
			skipped: allSources.length - inputs.length,
			failed: 0,
			themes: 0,
			themesResynthesized: 0,
		};

		for (const { source, body } of inputs) {
			const extraction = await this.extractSource(source, body);
			if (!extraction) {
				result.failed += 1;
				continue;
			}
			this.cache.extractions[source.path] = {
				mtime: source.mtime,
				extraction,
			};
			result.extracted += 1;
		}

		// Drop cache entries for sources that no longer exist in the vault.
		const seenPaths = new Set(allSources.map((s) => s.path));
		for (const path of Object.keys(this.cache.extractions)) {
			if (!seenPaths.has(path)) {
				delete this.cache.extractions[path];
			}
		}

		const themeResult = await this.syncThemes(allSources);
		result.themes = themeResult.total;
		result.themesResynthesized = themeResult.resynthesized;

		this.cache.lastSynced = todayISO;
		return result;
	}

	/**
	 * Synthesize each theme (topic shared by 2+ sources) via one LLM call,
	 * incrementally. A theme is re-synthesized only when its member set or any
	 * member's mtime changed (signature mismatch) — unchanged themes cost zero
	 * tokens. Syntheses for topics that are no longer themes are pruned.
	 *
	 * Phase 2: the signature/skip mechanics are real; {@link synthesizeTheme} is
	 * a stub, so no synthesis is ever stored yet.
	 */
	private async syncThemes(
		allSources: HighlightSource[]
	): Promise<{ total: number; resynthesized: number }> {
		const themes = this.themesOf(allSources);
		const activeTopics = new Set(themes.map((t) => t.topic));
		let resynthesized = 0;

		for (const theme of themes) {
			const signature = this.themeSignature(theme.members);
			const cached = this.cache.themeSyntheses[theme.topic];
			if (cached && cached.signature === signature) {
				// Members and their mtimes unchanged — reuse, no API call.
				continue;
			}

			const synthesis = await this.synthesizeTheme(theme.topic, theme.members);
			if (!synthesis) {
				// Leave any prior entry (stale signature) so the next sync retries.
				continue;
			}

			this.cache.themeSyntheses[theme.topic] = { signature, synthesis };
			resynthesized += 1;
		}

		// Prune syntheses for topics that are no longer themes.
		for (const topic of Object.keys(this.cache.themeSyntheses)) {
			if (!activeTopics.has(topic)) {
				delete this.cache.themeSyntheses[topic];
			}
		}

		return { total: themes.length, resynthesized };
	}

	/**
	 * Render the synthesis report as a markdown document. Pure and free: reads
	 * the in-memory cache and the collected sources — zero LLM calls — and
	 * returns a string; writing it to the vault is the caller's job.
	 *
	 * Phase 2: a placeholder document. Phase 3 fills in the real sections.
	 */
	buildReportMarkdown(sources: HighlightSource[], todayISO: string): string {
		// TODO (Phase 3): render the inbox, themes, and summary sections.
		void sources;
		const lines: string[] = [];
		lines.push("# Highlight Synthesis");
		lines.push("");
		lines.push(`_Last synced: ${this.cache.lastSynced || "never"}_`);
		lines.push(`_Generated: ${todayISO}_`);
		lines.push("");
		lines.push("_Report generation arrives in a later phase._");
		return lines.join("\n");
	}

	// --- Engine internals (all pure) ---

	/**
	 * Group sources into themes by shared topic (exact lowercase match). Only
	 * topics carried by 2+ distinct sources count as a theme. Ordered biggest
	 * theme first, then alphabetically — fully deterministic. Shared by the
	 * report and per-theme synthesis so both agree on what a theme is.
	 */
	private themesOf(
		sources: HighlightSource[]
	): Array<{ topic: string; members: HighlightSource[] }> {
		const groups = new Map<string, HighlightSource[]>();

		for (const source of sources) {
			const extraction = this.cache.extractions[source.path]?.extraction;
			if (!extraction) {
				continue;
			}
			// Dedupe topics within a source so a repeated label can't make one
			// source look like two members of the same theme.
			for (const topic of new Set(extraction.topics)) {
				const members = groups.get(topic) ?? [];
				members.push(source);
				groups.set(topic, members);
			}
		}

		return [...groups.entries()]
			.filter(([, members]) => members.length >= 2)
			.sort(
				([topicA, a], [topicB, b]) =>
					b.length - a.length || topicA.localeCompare(topicB)
			)
			.map(([topic, members]) => ({ topic, members }));
	}

	/**
	 * Cheap change-detection signature for a theme: a djb2 hash of its member
	 * paths and mtimes, sorted so order never affects it. Identical signature
	 * ⇒ same members, none edited ⇒ no need to re-synthesize.
	 */
	private themeSignature(members: HighlightSource[]): string {
		const parts = members.map((s) => `${s.path}:${s.mtime}`).sort();
		return this.hash(parts.join("|"));
	}

	/**
	 * Extract one source. Phase 2 stub — no LLM call yet, always returns null so
	 * nothing is written to the cache. Phase 3 adds the extraction prompt and
	 * defensive JSON parsing.
	 */
	private async extractSource(
		source: HighlightSource,
		body: string
	): Promise<SourceExtraction | null> {
		// TODO (Phase 3): build the extraction prompt, call this.llm.complete,
		// and parse the response into a SourceExtraction.
		void source;
		void body;
		return null;
	}

	/**
	 * Synthesize one theme from its members. Phase 2 stub — no LLM call yet,
	 * always returns null. Phase 3 adds the synthesis prompt and parsing.
	 */
	private async synthesizeTheme(
		topic: string,
		members: HighlightSource[]
	): Promise<ThemeSynthesis | null> {
		// TODO (Phase 3): build the theme prompt, call this.llm.complete, and
		// parse the response into a ThemeSynthesis.
		void topic;
		void members;
		return null;
	}

	/** Small deterministic djb2 hash, rendered as base-36. */
	private hash(input: string): string {
		let h = 5381;
		for (let i = 0; i < input.length; i++) {
			h = (((h << 5) + h) + input.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(36);
	}
}
