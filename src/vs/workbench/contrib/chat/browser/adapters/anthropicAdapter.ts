/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatResponse, ChatMessageRole } from '../../common/languageModels.js';
import { ICustomLMValidationResult } from './openAIAdapter.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';

interface IAnthropicMessage {
	role: 'user' | 'assistant';
	content: string;
}

interface IAnthropicResponse {
	content: Array<{ type: string; text: string }>;
	model: string;
	stop_reason: string;
}

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
		let text = '';
		for (const part of msg.content) {
			if (part.type === 'text') {
				text += part.value;
			}
		}
		if (msg.role === ChatMessageRole.System) {
			system = text;
		} else {
			result.push({ role: chatRoleToAnthropic(msg.role), content: text });
		}
	}

	return { system, messages: result };
}

export async function sendAnthropicChatRequest(
	apiKey: string | undefined,
	modelId: string,
	messages: IChatMessage[],
	requestService: IRequestService,
	token: CancellationToken
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
	const content = parsed.content?.find(c => c.type === 'text')?.text ?? '';

	const parts: IChatResponsePart[] = [{ type: 'text', value: content }];
	const stream = (async function* () { yield parts; })();

	return { stream, result: Promise.resolve(null) };
}

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
