/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IChatMessage, IChatResponsePart, ILanguageModelChatResponse } from '../../common/languageModels.js';
import { ICustomLMValidationResult, IOpenAITool, messagesToOpenAI, unsanitizeToolName } from './openAIAdapter.js';

export interface IVllmAdapterConfig {
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly modelId: string;
	/** Defaults to 'v3'. v3 uses /v3/chat/completions; v1 uses /v1/chat/completions. */
	readonly endpointVersion?: 'v1' | 'v3';
}

interface IVllmResponse {
	choices: Array<{
		message: {
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: 'function';
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason: string;
	}>;
}

function getChatCompletionsPath(endpointVersion: 'v1' | 'v3' | undefined): string {
	return endpointVersion === 'v1' ? '/v1/chat/completions' : '/v3/chat/completions';
}

function getModelsPath(endpointVersion: 'v1' | 'v3' | undefined): string {
	return endpointVersion === 'v1' ? '/v1/models' : '/v3/models';
}

export async function sendVllmChatRequest(
	config: IVllmAdapterConfig,
	messages: IChatMessage[],
	requestService: IRequestService,
	token: CancellationToken,
	tools?: IOpenAITool[],
): Promise<ILanguageModelChatResponse> {

	const path = getChatCompletionsPath(config.endpointVersion);
	const url = config.baseUrl.replace(/\/$/, '') + path;
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
		callSite: 'vllmAdapter',
	}, token).then(asText);

	if (!responseText) {
		throw new Error('Empty response from vLLM endpoint');
	}

	const parsed = JSON.parse(responseText) as IVllmResponse;
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
				// malformed JSON from model
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
 * Validates connectivity to a vLLM endpoint by calling GET /v3/models (or /v1/models).
 */
export async function validateVllmConfiguration(
	baseUrl: string,
	apiKey: string | undefined,
	endpointVersion: 'v1' | 'v3' | undefined,
	requestService: IRequestService,
	token: CancellationToken
): Promise<ICustomLMValidationResult> {

	const path = getModelsPath(endpointVersion);
	const url = baseUrl.replace(/\/$/, '') + path;
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
			callSite: 'vllmAdapter.validate',
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
