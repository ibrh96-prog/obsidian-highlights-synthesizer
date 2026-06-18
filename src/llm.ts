import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { HighlightInboxSettings } from "./settings";

// --- Provider response shapes (only the fields we read) ---

interface AnthropicTextBlock {
	type: string;
	text?: string;
}

interface AnthropicResponse {
	content?: AnthropicTextBlock[];
}

interface OpenAIChoice {
	message?: { content?: string };
}

interface OpenAIResponse {
	choices?: OpenAIChoice[];
}

const MAX_TOKENS = 4096;

/**
 * Cap on how many characters of source content the caller should send per
 * request. A source can carry many highlights, and small-context models (e.g.
 * free OpenRouter tiers) reject oversized prompts — truncate before calling
 * {@link LLMAdapter.complete}.
 */
export const MAX_INPUT_CHARS = 24000;

/**
 * Thin adapter over the configured chat provider. Knows nothing about
 * highlights — it just turns a (system, user) prompt pair into a string.
 * Always uses Obsidian's requestUrl (never fetch) so requests work on mobile
 * and bypass CORS.
 */
export class LLMAdapter {
	private readonly settings: HighlightInboxSettings;

	constructor(settings: HighlightInboxSettings) {
		this.settings = settings;
	}

	async complete(systemPrompt: string, userPrompt: string): Promise<string> {
		if (this.settings.provider === "anthropic") {
			return this.completeAnthropic(systemPrompt, userPrompt);
		}
		return this.completeOpenAI(systemPrompt, userPrompt);
	}

	private async completeAnthropic(
		systemPrompt: string,
		userPrompt: string
	): Promise<string> {
		const response = await requestUrl({
			url: `${this.settings.baseUrl}/v1/messages`,
			method: "POST",
			contentType: "application/json",
			headers: {
				"x-api-key": this.settings.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: this.settings.model,
				max_tokens: MAX_TOKENS,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }],
			}),
			throw: false,
		});

		this.assertOk(response);

		const data = response.json as AnthropicResponse;
		const text = (data.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("");
		return text;
	}

	private async completeOpenAI(
		systemPrompt: string,
		userPrompt: string
	): Promise<string> {
		// The user supplies the base URL without "/v1"; we append the full path.
		const response = await requestUrl({
			url: `${this.settings.baseUrl}/v1/chat/completions`,
			method: "POST",
			contentType: "application/json",
			headers: {
				Authorization: `Bearer ${this.settings.apiKey}`,
			},
			body: JSON.stringify({
				model: this.settings.model,
				max_tokens: MAX_TOKENS,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
			}),
			throw: false,
		});

		this.assertOk(response);

		const data = response.json as OpenAIResponse;
		return data.choices?.[0]?.message?.content ?? "";
	}

	private assertOk(response: RequestUrlResponse): void {
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`LLM request failed (${response.status}): ${response.text}`
			);
		}
	}
}
