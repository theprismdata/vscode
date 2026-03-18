/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatResponse, ChatMessageRole } from '../../common/languageModels.js';
import { ICustomLMValidationResult } from './openAIAdapter.js';
import { IFilePathResolver } from './filePathResolver.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Anthropic tool calling types
// ---------------------------------------------------------------------------

export interface IAnthropicTool {
	name: string;
	description: string;
	input_schema: unknown;
}

interface IAnthropicContentBlockText {
	type: 'text';
	text: string;
}

interface IAnthropicContentBlockToolUse {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface IAnthropicContentBlockToolResult {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

type IAnthropicContentBlock = IAnthropicContentBlockText | IAnthropicContentBlockToolUse | IAnthropicContentBlockToolResult;

// ---------------------------------------------------------------------------
// Anthropic message types
// ---------------------------------------------------------------------------

interface IAnthropicMessage {
	role: 'user' | 'assistant';
	content: string | IAnthropicContentBlock[];
}

interface IAnthropicResponse {
	content: IAnthropicContentBlock[];
	model: string;
	stop_reason: string;
}

// ---------------------------------------------------------------------------
// Tool name sanitization (Anthropic requires ^[a-zA-Z0-9_-]+$)
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

function unsanitizeToolName(sanitizedName: string): string {
	return _toolNameReverseMap.get(sanitizedName) ?? sanitizedName;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function chatRoleToAnthropic(role: ChatMessageRole): 'user' | 'assistant' {
	switch (role) {
		case ChatMessageRole.User: return 'user';
		case ChatMessageRole.Assistant: return 'assistant';
		case ChatMessageRole.System: return 'user'; // system handled separately
	}
}

function messagesToAnthropic(messages: IChatMessage[]): { system: string | undefined; messages: IAnthropicMessage[] } {
	let system: string | undefined;
	const result: IAnthropicMessage[] = [];

	for (const msg of messages) {
		// Handle tool_result parts → Anthropic user message with tool_result content blocks
		const toolResultParts = msg.content.filter(p => p.type === 'tool_result');
		if (toolResultParts.length > 0) {
			const contentBlocks: IAnthropicContentBlock[] = [];
			for (const part of toolResultParts) {
				if (part.type !== 'tool_result') {
					continue;
				}
				const textValue = part.value.map(v => v.type === 'text' ? v.value : '').join('');
				contentBlocks.push({
					type: 'tool_result',
					tool_use_id: part.toolCallId,
					content: textValue,
					is_error: part.isError,
				});
			}
			result.push({ role: 'user', content: contentBlocks });
			continue;
		}

		// Handle tool_use parts → Anthropic assistant message with tool_use content blocks
		const toolUseParts = msg.content.filter(p => p.type === 'tool_use');
		if (toolUseParts.length > 0 && msg.role === ChatMessageRole.Assistant) {
			const contentBlocks: IAnthropicContentBlock[] = [];
			// Include any text parts first
			for (const part of msg.content) {
				if (part.type === 'text' && part.value) {
					contentBlocks.push({ type: 'text', text: part.value });
				}
			}
			for (const part of toolUseParts) {
				if (part.type !== 'tool_use') {
					continue;
				}
				contentBlocks.push({
					type: 'tool_use',
					id: part.toolCallId,
					name: sanitizeToolName(part.name),
					input: part.parameters as Record<string, unknown>,
				});
			}
			result.push({ role: 'assistant', content: contentBlocks });
			continue;
		}

		// System message
		if (msg.role === ChatMessageRole.System) {
			let text = '';
			for (const part of msg.content) {
				if (part.type === 'text') {
					text += part.value;
				}
			}
			system = text;
			continue;
		}

		// Regular text message
		let text = '';
		for (const part of msg.content) {
			if (part.type === 'text') {
				text += part.value;
			}
		}
		result.push({ role: chatRoleToAnthropic(msg.role), content: text });
	}

	return { system, messages: result };
}

// ---------------------------------------------------------------------------
// Send chat request with optional tools
// ---------------------------------------------------------------------------

export async function sendAnthropicChatRequest(
	apiKey: string | undefined,
	modelId: string,
	messages: IChatMessage[],
	requestService: IRequestService,
	token: CancellationToken,
	tools?: IAnthropicTool[],
	filePathResolver?: IFilePathResolver,
): Promise<ILanguageModelChatResponse> {

	const url = `${ANTHROPIC_BASE_URL}/v1/messages`;
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': ANTHROPIC_API_VERSION,
	};
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}

	const { system, messages: anthropicMessages } = messagesToAnthropic(messages);

	const body: Record<string, unknown> = {
		model: modelId,
		max_tokens: 8096,
		messages: anthropicMessages,
	};
	if (system) {
		body['system'] = system;
	}
	if (tools && tools.length > 0) {
		body['tools'] = tools;
	}

	const responseText = await requestService.request({
		type: 'POST',
		url,
		headers,
		data: JSON.stringify(body),
		callSite: 'anthropicAdapter',
	}, token).then(asText);

	if (!responseText) {
		throw new Error('Empty response from Anthropic endpoint');
	}

	const parsed = JSON.parse(responseText) as IAnthropicResponse;

	const parts: IChatResponsePart[] = [];

	for (const block of parsed.content ?? []) {
		if (block.type === 'text') {
			// Detect file paths and split into text + inlineReference parts
			const matches = filePathResolver?.detectFilePaths(block.text);
			if (matches && matches.length > 0) {
				let cursor = 0;
				for (const match of matches) {
					if (match.start > cursor) {
						parts.push({ type: 'text', value: block.text.substring(cursor, match.start) });
					}
					parts.push({
						type: 'inlineReference',
						uri: match.uri,
						name: match.displayName,
					});
					cursor = match.end;
				}
				if (cursor < block.text.length) {
					parts.push({ type: 'text', value: block.text.substring(cursor) });
				}
			} else {
				parts.push({ type: 'text', value: block.text });
			}
		} else if (block.type === 'tool_use') {
			parts.push({
				type: 'tool_use',
				name: unsanitizeToolName(block.name),
				toolCallId: block.id,
				parameters: block.input,
			});
		}
	}

	if (parts.length === 0) {
		parts.push({ type: 'text', value: '' });
	}

	const stream = (async function* () { yield parts; })();

	return { stream, result: Promise.resolve(null) };
}

// ---------------------------------------------------------------------------
// Convert VS Code IToolData → Anthropic tool format
// ---------------------------------------------------------------------------

export function toolDataToAnthropic(tool: { id: string; modelDescription?: string; displayName: string; inputSchema?: unknown }): IAnthropicTool {
	return {
		name: sanitizeToolName(tool.id),
		description: tool.modelDescription || tool.displayName,
		input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
	};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateAnthropicConfiguration(
	apiKey: string | undefined,
	requestService: IRequestService,
	token: CancellationToken
): Promise<ICustomLMValidationResult> {

	const url = `${ANTHROPIC_BASE_URL}/v1/models`;
	const headers: Record<string, string> = {
		'anthropic-version': ANTHROPIC_API_VERSION,
	};
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}

	try {
		const ctx = await requestService.request({ type: 'GET', url, headers, timeout: 10000, callSite: 'anthropicAdapter.validate' }, token);
		const statusCode = ctx.res.statusCode ?? 0;

		if (statusCode === 401 || statusCode === 403) {
			return { ok: false, error: 'auth', message: `Authentication failed (HTTP ${statusCode})` };
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
