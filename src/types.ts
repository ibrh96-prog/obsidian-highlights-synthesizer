// Core domain types for the Highlight Inbox Synthesizer plugin.

/** Source kind, read from frontmatter "category". Unknown values stay undefined. */
export type HighlightCategory =
	| "books"
	| "articles"
	| "tweets"
	| "podcasts"
	| "videos";

/** A single highlight pulled from a source file's body. */
export interface Highlight {
	text: string; // the highlighted passage itself
	note?: string; // the reader's own note attached to the highlight
	blockId?: string; // markdown block id (e.g. "rw-abc123"), when present
}

/**
 * One source file = one source. Highlights are parsed from the body; every
 * frontmatter field is optional and read defensively, since Readwise/clipper
 * templates vary.
 */
export interface HighlightSource {
	path: string;
	title: string;
	mtime: number; // file last-modified time, for incremental sync
	category?: HighlightCategory; // frontmatter "category"
	author?: string; // frontmatter "author"
	url?: string; // frontmatter "url" or "source"
	highlightedDate?: string; // frontmatter "highlighted_date", normalized YYYY-MM-DD
	tags: string[]; // frontmatter "tags"
	highlights: Highlight[]; // parsed from the body
}

/**
 * Per-source extraction, the Highlight Inbox analogue of Reading Inbox's
 * ClipExtraction. One source file yields one extraction.
 */
export interface SourceExtraction {
	id: string; // djb2 hash of the source path
	summary: string; // 2-3 sentences, in the source's own language
	keyClaims: string[]; // in the source's own language
	topics: string[]; // lowercase
	language?: string; // ISO 639-1 code of the source
}

export interface ThemeSynthesis {
	consensus: string; // 1-2 sentences: what the sources agree on
	tension: string; // 1-2 sentences: where they diverge, or "" if none
	language?: string; // ISO 639-1 of the dominant source language
}

export interface SynthesisCache {
	extractions: Record<string, { mtime: number; extraction: SourceExtraction }>;
	// Per-theme LLM synthesis, keyed by theme (lowercase topic). `signature`
	// is a hash of the member set + their mtimes, so an unchanged theme is
	// never re-synthesized (zero tokens on re-sync).
	themeSyntheses: Record<string, { signature: string; synthesis: ThemeSynthesis }>;
	lastSynced: string;
}

/**
 * Lifetime free-tier usage. A "use" is one successful sync; there is no monthly
 * reset, so the count only ever grows until a Pro license unlocks it.
 */
export interface FreeUsage {
	count: number;
}
