import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

export default class HighlightInboxSynthesizerPlugin extends Plugin {
	override async onload(): Promise<void> {
		// Placeholder ribbon icon — no behavior yet (Phase 1 shell).
		this.addRibbonIcon("highlighter", "Highlight Inbox Synthesizer", () => {});

		this.addSettingTab(new HighlightInboxSettingTab(this.app, this));
	}

	override onunload(): void {}
}

class HighlightInboxSettingTab extends PluginSettingTab {
	constructor(app: App, plugin: HighlightInboxSynthesizerPlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Highlight Inbox Synthesizer").setHeading();
	}
}
