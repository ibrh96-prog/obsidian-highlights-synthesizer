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

// --- Shape the LLM is asked to return (validated before use) ---

interface RawExtraction {
	summary: string;
	keyClaims: string[];
	topics: string[];
	language?: string;
}

/**
 * Why a parse attempt yielded nothing usable. "invalid-json" and "empty"
 * (syntactically valid JSON but no real value in it) have different causes in
 * the field — weak JSON mode vs. thin highlights the model couldn't summarize —
 * so they are reported separately. Generic over the parsed payload so
 * extraction and theme synthesis share the same defensive shape.
 */
type ParseOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "invalid-json" }
	| { kind: "empty" };

const EXTRACTION_SYSTEM_PROMPT = [
	"You are a highlight-inbox extraction engine. You are given a set of curated",
	"highlights a reader saved from one source — a book, article, podcast, tweet,",
	"or video. Read the highlights and extract what they are collectively about,",
	"the key claims across them, their topics, and language.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "summary": string,',
	'  "keyClaims": string[],',
	'  "topics": string[],',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- "summary" is 2-3 sentences giving a high-level overview of what these',
	"  highlights are collectively about, written in the source's own language.",
	'- "keyClaims" are 2-4 specific claims, findings, or arguments expressed',
	"  across the highlights — each one sentence, in the source's own language.",
	"  They must add concrete detail NOT already stated in the summary; do not",
	"  restate the summary. If the highlights make no specific claims, use an",
	"  empty array.",
	'- "topics" are 2-5 short lowercase category labels (1-3 words each).',
	"  Use BROAD, reusable categories that other sources would also share,",
	"  NOT specific names, products, or events. For example use",
	'  "artificial intelligence" not "claude fable 5"; "climate policy" not',
	'  "the 2026 paris summit"; "personal finance" not "my fidelity account".',
	"  Prefer the most standard, conventional name for each category.",
	'- "language" is the ISO 639-1 code of the source\'s language,',
	'  e.g. "en", "tr", "de".',
	'- If a field is unknown, use an empty array or "" as appropriate.',
	"- Do NOT invent content that is not in the highlights.",
].join("\n");

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
 * Phase 3 step 1: per-source extraction is live. Theme synthesis and report
 * rendering are still stubbed and arrive in steps 2 and 3.
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
	 * the in-memory cache and the collected sources — ZERO LLM calls — and returns
	 * a string; writing it to the vault is the caller's job. `todayISO`
	 * (YYYY-MM-DD) is the caller's clock — the engine never reads the clock.
	 *
	 * Step 2: per-source sections only, built from cached extractions. The
	 * cross-source Themes section is added in Step 3.
	 */
	buildReportMarkdown(sources: HighlightSource[], todayISO: string): string {
		const extractionOf = (source: HighlightSource) =>
			this.cache.extractions[source.path]?.extraction;

		// Only sources with a cached extraction are rendered; newest highlighted
		// first, undated last. Pure string sort on the already-normalized
		// YYYY-MM-DD date — the engine never parses or computes dates.
		const synced = sources
			.filter((source) => extractionOf(source) !== undefined)
			.sort((a, b) =>
				(b.highlightedDate ?? "").localeCompare(a.highlightedDate ?? "")
			);

		const lines: string[] = [];

		lines.push("# Highlight Inbox Synthesis");
		lines.push("");
		lines.push(
			`_${synced.length} ${synced.length === 1 ? "source" : "sources"} · generated ${todayISO}_`
		);
		lines.push("");

		// TODO (Step 3): render the cross-source "## Themes" section here —
		// consensus/tension paragraphs from this.cache.themeSyntheses, grouped by
		// this.themesOf(sources). Step 2 deliberately renders per-source only.

		lines.push("## Sources");
		lines.push("");

		if (synced.length === 0) {
			lines.push('_No extractions yet — run "Sync highlights" first._');
			lines.push("");
			return lines.join("\n");
		}

		for (const source of synced) {
			const extraction = extractionOf(source);
			if (!extraction) {
				continue;
			}

			lines.push(`### ${source.title}`);
			lines.push("");

			const byline = this.byline(source);
			if (byline !== "") {
				lines.push(`_${byline}_`);
				lines.push("");
			}

			lines.push(extraction.summary);
			lines.push("");

			if (extraction.keyClaims.length > 0) {
				lines.push("**Key claims**");
				lines.push("");
				for (const claim of extraction.keyClaims) {
					lines.push(`- ${claim}`);
				}
				lines.push("");
			}

			if (extraction.topics.length > 0) {
				lines.push(`**Topics:** ${extraction.topics.join(", ")}`);
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	/** Italic-ready byline from author/category, omitting absent parts. */
	private byline(source: HighlightSource): string {
		const parts: string[] = [];
		if (source.author) {
			parts.push(`by ${source.author}`);
		}
		if (source.category) {
			parts.push(source.category);
		}
		return parts.join(" · ");
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
	 * Ask the LLM to extract one source from its prepared highlights. Parses the
	 * response defensively and retries once on a parse failure. Returns null (and
	 * warns) if both attempts fail — or if the request itself throws
	 * (network/auth) — so the caller can count the failure without aborting the
	 * whole sync.
	 */
	private async extractSource(
		source: HighlightSource,
		body: string
	): Promise<SourceExtraction | null> {
		const userPrompt = this.buildUserPrompt(source, body);

		try {
			const first = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				userPrompt
			);
			const firstOutcome = this.parseExtraction(first);
			if (firstOutcome.kind === "ok") {
				return this.toSourceExtraction(source, firstOutcome.value);
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but contained no summary. " +
						"Return the JSON object with a non-empty summary."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				retryPrompt
			);
			const secondOutcome = this.parseExtraction(second);
			if (secondOutcome.kind === "ok") {
				return this.toSourceExtraction(source, secondOutcome.value);
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but empty extraction"
					: "invalid JSON";
			console.warn(
				`[Highlight Inbox Synthesizer] Extraction failed (${reason}) for source: ${source.path}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Highlight Inbox Synthesizer] Extraction request failed for source: ${source.path}`,
				error
			);
			return null;
		}
	}

	/** Assemble the user prompt from the source metadata and its highlights. */
	private buildUserPrompt(source: HighlightSource, body: string): string {
		const lines = [`Title: ${source.title}`];
		if (source.url) {
			lines.push(`URL: ${source.url}`);
		}
		if (source.author) {
			lines.push(`Author: ${source.author}`);
		}
		if (source.category) {
			lines.push(`Category: ${source.category}`);
		}
		lines.push("", "Highlights:", body);
		return lines.join("\n");
	}

	/** Assemble the cached extraction from a validated LLM result. */
	private toSourceExtraction(
		source: HighlightSource,
		raw: RawExtraction
	): SourceExtraction {
		const extraction: SourceExtraction = {
			id: this.hash(source.path),
			summary: raw.summary,
			keyClaims: raw.keyClaims,
			topics: raw.topics,
		};
		if (raw.language !== undefined) {
			extraction.language = raw.language;
		}
		return extraction;
	}

	private parseExtraction(raw: string): ParseOutcome<RawExtraction> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		const extraction = this.coerceExtraction(value);
		if (extraction === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", value: extraction };
	}

	/**
	 * Best-effort JSON recovery from a raw model response. Strips code fences,
	 * parses as-is, and if that fails retries on the substring from the first "{"
	 * to the last "}" (weak models often wrap JSON in prose like "Here is the
	 * JSON: {…}"). Returns undefined when nothing parses — a safe sentinel, since
	 * JSON.parse never yields it.
	 */
	private extractJsonValue(raw: string): unknown {
		const cleaned = this.stripFences(raw);

		const direct = this.tryParseJson(cleaned);
		if (direct !== undefined) {
			return direct;
		}

		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start !== -1 && end > start) {
			return this.tryParseJson(cleaned.slice(start, end + 1));
		}
		return undefined;
	}

	/** JSON.parse that returns undefined instead of throwing. (JSON.parse
	 * itself can never produce undefined, so it's a safe failure sentinel.) */
	private tryParseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Remove an accidental ```json … ``` wrapper before parsing. */
	private stripFences(raw: string): string {
		let text = raw.trim();
		if (text.startsWith("```")) {
			text = text
				.replace(/^```[a-zA-Z]*\s*/, "")
				.replace(/\s*```$/, "");
		}
		return text.trim();
	}

	/** Validate/normalize an arbitrary parsed value into a RawExtraction. */
	private coerceExtraction(value: unknown): RawExtraction | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const summary =
			typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
		if (summary === "") {
			return null;
		}

		const extraction: RawExtraction = {
			summary,
			keyClaims: this.toStringArray(obj["keyClaims"]),
			topics: this.toStringArray(obj["topics"]).map((t) => t.toLowerCase()),
		};

		// Accept "en" but also sloppy variants like "en-US"; keep the 639-1 part.
		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			extraction.language = languageMatch[0];
		}

		return extraction;
	}

	private toStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter((v) => v !== "");
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
