/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatResponse, ChatMessageRole } from '../../common/languageModels.js';
import { IToolData } from '../../common/tools/languageModelToolsService.js';

export interface IOpenAIAdapterConfig {
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly modelId: string;
}

export interface ICustomLMValidationResult {
	readonly ok: boolean;
	readonly error?: 'auth' | 'timeout' | 'notFound' | 'invalidResponse' | 'networkError';
	readonly message?: string;
}

// ---------------------------------------------------------------------------
// OpenAI tool calling types
// ---------------------------------------------------------------------------

export interface IOpenAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
}

export interface IOpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

// ---------------------------------------------------------------------------
// OpenAI message types (extended for tool calling)
// ---------------------------------------------------------------------------

interface IOpenAIMessageBase {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
}

interface IOpenAIAssistantMessage extends IOpenAIMessageBase {
	role: 'assistant';
	tool_calls?: IOpenAIToolCall[];
}

interface IOpenAIToolMessage extends IOpenAIMessageBase {
	role: 'tool';
	tool_call_id: string;
}

type IOpenAIMessage = IOpenAIMessageBase | IOpenAIAssistantMessage | IOpenAIToolMessage;

// ---------------------------------------------------------------------------
// OpenAI response types
// ---------------------------------------------------------------------------

interface IOpenAIResponse {
	choices: Array<{
		message: {
			content: string | null;
			tool_calls?: IOpenAIToolCall[];
		};
		finish_reason: string;
	}>;
}

// ---------------------------------------------------------------------------
// Tool name sanitization (OpenAI requires ^[a-zA-Z0-9_-]+$)
// ---------------------------------------------------------------------------

const _toolNameMap = new Map<string, string>();
const _toolNameReverseMap = new Map<string, string>();

function sanitizeToolName(toolId: string): string {
	const existing = _toolNameMap.get(toolId);
	if (existing) {
		return existing;
	}
	const sanitized = toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
	_toolNameMap.set(toolId, sanitized);
	_toolNameReverseMap.set(sanitized, toolId);
	return sanitized;
}

export function unsanitizeToolName(sanitizedName: string): string {
	return _toolNameReverseMap.get(sanitizedName) ?? sanitizedName;
}

// ---------------------------------------------------------------------------
// Convert VS Code IToolData → OpenAI function tool format
// ---------------------------------------------------------------------------

export function toolDataToOpenAI(tool: IToolData): IOpenAITool {
	return {
		type: 'function',
		function: {
			name: sanitizeToolName(tool.id),
			description: tool.modelDescription || tool.displayName,
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	};
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function chatRoleToOpenAI(role: ChatMessageRole): 'system' | 'user' | 'assistant' {
	switch (role) {
		case ChatMessageRole.System: return 'system';
		case ChatMessageRole.User: return 'user';
		case ChatMessageRole.Assistant: return 'assistant';
	}
}

export function messagesToOpenAI(messages: IChatMessage[]): IOpenAIMessage[] {
	const result: IOpenAIMessage[] = [];
	for (const msg of messages) {
		// Handle tool_result parts → OpenAI "tool" role messages
		for (const part of msg.content) {
			if (part.type === 'tool_result') {
				const textValue = part.value.map(v => v.type === 'text' ? v.value : '').join('');
				result.push({
					role: 'tool',
					tool_call_id: part.toolCallId,
					content: textValue,
				} as IOpenAIToolMessage);
			}
		}

		// Handle tool_use parts → OpenAI assistant message with tool_calls
		const toolUseParts = msg.content.filter(p => p.type === 'tool_use');
		if (toolUseParts.length > 0 && msg.role === ChatMessageRole.Assistant) {
			const textParts = msg.content.filter(p => p.type === 'text');
			const textContent = textParts.map(p => p.type === 'text' ? p.value : '').join('');
			result.push({
				role: 'assistant',
				content: textContent || null,
				tool_calls: toolUseParts.map(p => {
					if (p.type !== 'tool_use') {
						throw new Error('Unexpected part type');
					}
					return {
						id: p.toolCallId,
						type: 'function' as const,
						function: {
							name: sanitizeToolName(p.name),
							arguments: JSON.stringify(p.parameters),
						},
					};
				}),
			} as IOpenAIAssistantMessage);
			continue;
		}

		// Handle tool_result messages (already added above)
		if (msg.content.some(p => p.type === 'tool_result')) {
			continue;
		}

		// Regular text message
		let text = '';
		for (const part of msg.content) {
			if (part.type === 'text') {
				text += part.value;
			}
		}
		result.push({ role: chatRoleToOpenAI(msg.role), content: text });
	}
	return result;
}

// ---------------------------------------------------------------------------
// Send chat request with optional tools
// ---------------------------------------------------------------------------

export async function sendOpenAIChatRequest(
	config: IOpenAIAdapterConfig,
	messages: IChatMessage[],
	requestService: IRequestService,
	token: CancellationToken,
	tools?: IOpenAITool[],
): Promise<ILanguageModelChatResponse> {

	const url = config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions';
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	const requestBody: Record<string, unknown> = {
		model: config.modelId,
		messages: messagesToOpenAI(messages),
		stream: false,
	};
	if (tools && tools.length > 0) {
		requestBody['tools'] = tools;
	}

	const responseText = await requestService.request({
		type: 'POST',
		url,
		headers,
		data: JSON.stringify(requestBody),
		callSite: 'openAIAdapter',
	}, token).then(asText);

	if (!responseText) {
		throw new Error('Empty response from OpenAI-compatible endpoint');
	}

	const parsed = JSON.parse(responseText) as IOpenAIResponse;
	const choice = parsed.choices?.[0];
	const content = choice?.message?.content ?? '';
	const toolCalls = choice?.message?.tool_calls;

	const parts: IChatResponsePart[] = [];

	if (content) {
		parts.push({ type: 'text', value: content });
	}

	if (toolCalls && toolCalls.length > 0) {
		for (const tc of toolCalls) {
			let parameters: Record<string, unknown> = {};
			try {
				parameters = JSON.parse(tc.function.arguments);
			} catch {
				// malformed JSON from model — pass empty params
			}
			parts.push({
				type: 'tool_use',
				name: unsanitizeToolName(tc.function.name),
				toolCallId: tc.id,
				parameters,
			});
		}
	}

	const stream = (async function* () {
		yield parts;
	})();

	return {
		stream,
		result: Promise.resolve(null),
	};
}

/**
 * Validates connectivity to an OpenAI-compatible endpoint by calling GET /models.
 * Returns a structured result describing success or failure category.
 */
export async function validateOpenAIConfiguration(
	baseUrl: string,
	apiKey: string | undefined,
	requestService: IRequestService,
	token: CancellationToken
): Promise<ICustomLMValidationResult> {

	const url = baseUrl.replace(/\/$/, '') + '/v1/models';
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers['Authorization'] = `Bearer ${apiKey}`;
	}

	try {
		const ctx = await requestService.request({
			type: 'GET',
			url,
			headers,
			timeout: 10000,
			callSite: 'openAIAdapter.validate',
		}, token);

		const statusCode = ctx.res.statusCode ?? 0;

		if (statusCode === 401 || statusCode === 403) {
			return { ok: false, error: 'auth', message: `Authentication failed (HTTP ${statusCode})` };
		}
		if (statusCode === 404) {
			return { ok: false, error: 'notFound', message: `Endpoint not found (HTTP 404): ${url}` };
		}
		if (statusCode >= 200 && statusCode < 300) {
			return { ok: true };
		}

		const text = await asText(ctx);
		return { ok: false, error: 'invalidResponse', message: `Unexpected HTTP ${statusCode}: ${text?.slice(0, 200)}` };

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.toLowerCase().includes('timeout')) {
			return { ok: false, error: 'timeout', message: msg };
		}
		return { ok: false, error: 'networkError', message: msg };
	}
}

export function estimateTokenCount(text: string): number {
	// Rough estimate: ~4 chars per token
	return Math.ceil(text.length / 4);
}
