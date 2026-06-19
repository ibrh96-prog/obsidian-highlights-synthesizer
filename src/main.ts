import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	HighlightInboxSettingTab,
	type HighlightInboxSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { HighlightCollector } from "./collector";
import { SynthesisEngine, type SourceInput } from "./synthesizer";
import { verifyLicense } from "./license";
import type { FreeUsage, HighlightSource, SynthesisCache } from "./types";

function emptyCache(): SynthesisCache {
	return { extractions: {}, themeSyntheses: {}, lastSynced: "" };
}

function emptyFreeUsage(): FreeUsage {
	return { count: 0 };
}

/**
 * Shape of the single JSON blob Obsidian persists for this plugin. Settings, the
 * synthesis cache, and lifetime free usage live side by side so saving one never
 * clobbers the others.
 */
interface PersistedData {
	settings: HighlightInboxSettings;
	cache: SynthesisCache;
	freeUsage: FreeUsage;
}

export default class HighlightInboxSynthesizerPlugin extends Plugin {
	settings: HighlightInboxSettings = DEFAULT_SETTINGS;
	cache: SynthesisCache = emptyCache();
	freeUsage: FreeUsage = emptyFreeUsage();

	llm!: LLMAdapter;
	collector!: HighlightCollector;
	engine!: SynthesisEngine;

	override async onload(): Promise<void> {
		console.log("Highlight Inbox Synthesizer loaded.");

		await this.loadSettings();

		this.llm = new LLMAdapter(this.settings);
		this.collector = new HighlightCollector(this.app, this.settings);
		this.engine = new SynthesisEngine(this.llm, this.cache);

		this.addSettingTab(new HighlightInboxSettingTab(this.app, this));

		this.addCommand({
			id: "sync-highlights",
			name: "Sync highlights",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "generate-highlights-report",
			name: "Generate highlights report",
			callback: () => {
				void this.runGenerateReport();
			},
		});

		this.addRibbonIcon("highlighter", "Generate highlights report", () => {
			void this.runGenerateReport();
		});
	}

	override onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PersistedData> | null;

		// Tolerate a legacy flat-settings layout (a build that saved the settings
		// object at the top level) so an existing API key survives.
		const settingsSource =
			data && "settings" in data
				? data.settings
				: (data as Partial<HighlightInboxSettings> | null);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource ?? {});

		this.cache = (data && "cache" in data ? data.cache : null) ?? emptyCache();
		this.freeUsage =
			(data && "freeUsage" in data ? data.freeUsage : null) ??
			emptyFreeUsage();
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	/** Persist settings, cache, and free usage together as one blob. */
	private async persist(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			cache: this.cache,
			freeUsage: this.freeUsage,
		};
		await this.saveData(data);
	}

	/**
	 * Sync the highlight inbox: collect sources, prepare highlights for the
	 * new/changed ones, hand them to the pure engine, persist the cache. All
	 * vault I/O happens here — the engine never touches files.
	 */
	private async runSync(): Promise<void> {
		// Pro gate. Lifetime free tier: 3 successful syncs, no monthly reset.
		// Pro users are never counted or blocked. Bail before any LLM call.
		// Pro requires a license whose Ed25519 signature verifies AND whose
		// product matches; an invalid or empty key falls through to the free tier
		// (the plugin still works — it's just gated), never a hard block.
		const isPro = verifyLicense(this.settings.proLicenseKey).valid;
		if (!isPro && this.freeUsage.count >= 3) {
			new Notice(
				"Free limit reached: 3 total syncs. Upgrade to Pro for unlimited."
			);
			return;
		}

		try {
			const sources = await this.collector.collect();

			const inputs: SourceInput[] = [];
			for (const source of sources) {
				if (!this.engine.needsExtraction(source)) {
					continue;
				}
				const body = this.prepareBody(source);
				if (body === null) {
					continue;
				}
				inputs.push({ source, body });
			}

			if (inputs.length > 0) {
				new Notice(
					`Extracting ${inputs.length} source${inputs.length === 1 ? "" : "s"}...`
				);
			}

			const result = await this.engine.syncSources(
				sources,
				inputs,
				this.todayISO()
			);
			await this.persist();

			// Count the use only after a successful sync that extracted at least
			// one source. One sync = one use, regardless of how many it touched; a
			// sync that extracts nothing (all skipped/failed) never burns a use.
			if (!isPro && result.extracted > 0) {
				this.freeUsage.count += 1;
				await this.persist();
			}

			new Notice(
				`Synced: ${result.extracted} extracted, ` +
					`${result.skipped} skipped, ${result.failed} failed · ` +
					`${result.themes} themes (${result.themesResynthesized} re-synthesized).`
			);
		} catch (error) {
			console.error("Highlight Inbox Synthesizer: sync failed", error);
			new Notice("Sync failed. See console for details.");
		}
	}

	/**
	 * Prepare a source's highlights for extraction: join the highlight fragments
	 * (and any attached notes), strip markdown noise, then truncate to
	 * MAX_INPUT_CHARS so a heavily-highlighted source still fits small-context
	 * models. Returns null when there is no usable content to send.
	 */
	private prepareBody(source: HighlightSource): string | null {
		if (source.highlights.length === 0) {
			return null;
		}
		const parts: string[] = [];
		for (const highlight of source.highlights) {
			parts.push(highlight.text);
			if (highlight.note) {
				parts.push(`Note: ${highlight.note}`);
			}
		}
		const cleaned = this.cleanBody(parts.join("\n\n")).slice(0, MAX_INPUT_CHARS);
		return cleaned === "" ? null : cleaned;
	}

	/**
	 * Strip markdown noise so the truncation window lands on real prose, not
	 * link boilerplate: highlight fragments can carry source links and image
	 * embeds that would otherwise waste the context budget.
	 */
	private cleanBody(text: string): string {
		// Image embeds carry no prose — drop them entirely.
		let cleaned = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
		// Markdown links: keep the visible text, drop the URL.
		cleaned = cleaned.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
		// Bare URLs are pure token waste.
		cleaned = cleaned.replace(/https?:\/\/\S+/g, "");

		// Blank out lines left with no letters or digits, then collapse the gaps
		// so highlight structure survives but boilerplate runs don't.
		cleaned = cleaned
			.split("\n")
			.map((line) => (/[\p{L}\p{N}]/u.test(line) ? line : ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");

		return cleaned.trim();
	}

	/**
	 * Render the report from the current cache and write it to a fixed vault
	 * note, overwriting if it exists, then open it. ZERO LLM calls and never
	 * gated — report generation is always free and never touches the free
	 * counter. Collecting sources only reads vault metadata/bodies.
	 */
	private async runGenerateReport(): Promise<void> {
		if (Object.keys(this.cache.extractions).length === 0) {
			new Notice("Nothing to report — run Sync highlights first.");
			return;
		}

		const path = "Highlight Inbox Synthesis.md";
		try {
			const sources = await this.collector.collect();
			const markdown = this.engine.buildReportMarkdown(
				sources,
				this.todayISO()
			);

			const existing = this.app.vault.getAbstractFileByPath(path);
			let file: TFile;
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, markdown);
				file = existing;
			} else {
				file = await this.app.vault.create(path, markdown);
			}

			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice("Report written to Highlight Inbox Synthesis.md");
		} catch (error) {
			console.error(
				"Highlight Inbox Synthesizer: failed to write report",
				error
			);
			new Notice("Failed to write report. See console.");
		}
	}

	/**
	 * Today as a calendar-date string (YYYY-MM-DD) in LOCAL time — never
	 * toISOString(), which would shift the date across the UTC boundary in
	 * non-UTC timezones. The engine never reads the clock; this is where "today"
	 * enters the system.
	 */
	private todayISO(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
}
