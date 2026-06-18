import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	HighlightInboxSettingTab,
	type HighlightInboxSettings,
} from "./settings";
import { LLMAdapter } from "./llm";
import { HighlightCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import type { FreeUsage, SynthesisCache } from "./types";

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
	 * Sync the highlight inbox. Phase 2 stub — collection, extraction, synthesis,
	 * and the free-tier gate arrive in Phase 3.
	 */
	private async runSync(): Promise<void> {
		// TODO (Phase 3): gate on free tier, collect sources, extract, persist.
		new Notice("Sync highlights: coming soon.");
	}

	/**
	 * Render the report from the current cache and write it to the vault. Phase 2
	 * stub — the real report writing arrives in Phase 3.
	 */
	private async runGenerateReport(): Promise<void> {
		// TODO (Phase 3): build the report markdown and write it to the vault.
		new Notice("Generate highlights report: coming soon.");
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
