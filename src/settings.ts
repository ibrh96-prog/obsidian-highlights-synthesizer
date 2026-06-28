import { App, PluginSettingTab, Setting } from "obsidian";
import type HighlightInboxSynthesizerPlugin from "./main";
import { verifyLicense, GUMROAD_URL } from "./license";

export type LLMProvider = "anthropic" | "openai-compatible";

/** Default model identifier, used for the placeholder and the seed settings. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface HighlightInboxSettings {
	provider: LLMProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	sourceFolder: string;
	sourceTag: string;
	proLicenseKey: string;
}

export const DEFAULT_SETTINGS: HighlightInboxSettings = {
	provider: "anthropic",
	apiKey: "",
	baseUrl: "https://api.anthropic.com",
	model: DEFAULT_MODEL,
	sourceFolder: "Readwise/",
	sourceTag: "readwise",
	proLicenseKey: "",
};

export class HighlightInboxSettingTab extends PluginSettingTab {
	private readonly plugin: HighlightInboxSynthesizerPlugin;

	constructor(app: App, plugin: HighlightInboxSynthesizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- (a) Language model section ---
		new Setting(containerEl).setName("Language model").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Which API shape to use for synthesis requests.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("anthropic", "Anthropic")
					.addOption("openai-compatible", "OpenAI-compatible")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as LLMProvider;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Stored locally in this vault. Never committed or shared.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("API endpoint root, without a trailing slash.")
			.addText((text) => {
				text
					.setPlaceholder("https://api.anthropic.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model identifier passed to the provider.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_MODEL)
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- (b) Source location section ---
		new Setting(containerEl).setName("Source location").setHeading();

		new Setting(containerEl)
			.setName("Source folder")
			.setDesc("Vault-relative folder whose notes are treated as highlight sources.")
			.addText((text) => {
				text
					.setPlaceholder("Readwise/")
					.setValue(this.plugin.settings.sourceFolder)
					.onChange(async (value) => {
						this.plugin.settings.sourceFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Source tag")
			.setDesc("Any note carrying this tag also counts as a highlight source.")
			.addText((text) => {
				text
					.setPlaceholder("readwise")
					.setValue(this.plugin.settings.sourceTag)
					.onChange(async (value) => {
						this.plugin.settings.sourceTag = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- (c) License section ---
		new Setting(containerEl).setName("License").setHeading();

		new Setting(containerEl)
			.setName("Pro license key")
			.setDesc("Unlocks Pro features. Leave empty to run the free tier.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("HIS-...")
					.setValue(this.plugin.settings.proLicenseKey)
					.onChange(async (value) => {
						this.plugin.settings.proLicenseKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const status = verifyLicense(this.plugin.settings.proLicenseKey);
		if (status.valid) {
			new Setting(containerEl)
				.setName("✓ Pro active")
				.setDesc(`Licensed to ${status.email}`);
		} else if (this.plugin.settings.proLicenseKey) {
			new Setting(containerEl)
				.setName("License invalid")
				.setDesc(status.reason ?? "Could not verify license key.");
		} else {
			new Setting(containerEl).setDesc(
				`Free tier — 3 total syncs (${this.plugin.freeUsage.count}/3 used)`
			);
		}

		if (!status.valid) {
			new Setting(containerEl)
				.setName("Upgrade to Pro")
				.setDesc("Unlimited syncs, one-time payment, no subscription.")
				.addButton((button) => {
					button
						.setButtonText("Get Pro license")
						.onClick(() => {
							window.open(GUMROAD_URL, "_blank");
						});
				});
		}
	}
}
