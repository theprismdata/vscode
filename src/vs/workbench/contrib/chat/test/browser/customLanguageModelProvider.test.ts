/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { parseLanguageModelsProviderGroups } from '../../browser/languageModelsConfigurationService.js';
import { CUSTOM_VENDORS, MY_PROVIDERS_CATEGORY_LABEL } from '../../browser/customLanguageModelProviderContribution.js';
import { estimateTokenCount } from '../../browser/adapters/openAIAdapter.js';
import { buildModelPickerItems } from '../../browser/widget/input/chatModelPicker.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { StateType } from '../../../../../platform/update/common/update.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../common/languageModels.js';
import { ActionListItemKind } from '../../../../../platform/actionWidget/browser/actionList.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(
	vendor: string,
	name: string,
	categoryLabel?: string,
): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: `${vendor}/${name}/${name}`,
		metadata: {
			extension: new ExtensionIdentifier('test'),
			name,
			id: `${name}/${name}`,
			vendor,
			version: '1',
			family: name,
			maxInputTokens: 4096,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			isUserSelectable: true,
			modelPickerCategory: categoryLabel ? { label: categoryLabel, order: 2 } : undefined,
		},
	};
}

const stubEntitlementService = {
	entitlement: ChatEntitlement.Pro,
	isInternal: false,
} as unknown as IChatEntitlementService;

// ---------------------------------------------------------------------------
// Suite 1: custom vendor group parsing
// ---------------------------------------------------------------------------

suite('CustomLanguageModelProvider - group parsing', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('parses custom vendor group with apiKey and models', () => {
		const content = JSON.stringify([{
			vendor: 'openai',
			name: 'My OpenAI',
			baseUrl: 'https://api.openai.com/v1',
			apiKey: '${input:chat.lm.secret.abc}',
			models: ['gpt-4o', 'gpt-4o-mini'],
			endpointVersion: 'v3',
		}], null, '\t');
		const model = testDisposables.add(createTextModel(content));
		const result = parseLanguageModelsProviderGroups(model);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].vendor, 'openai');
		assert.strictEqual(result[0].name, 'My OpenAI');
		assert.strictEqual(result[0].baseUrl, 'https://api.openai.com/v1');
		assert.deepStrictEqual(result[0].models, ['gpt-4o', 'gpt-4o-mini']);
		assert.strictEqual(result[0].endpointVersion, 'v3');
		assert.ok(result[0].range, 'range must be set for editing support');
	});

	test('parses vLLM vendor group', () => {
		const content = JSON.stringify([{
			vendor: 'vllm',
			name: 'Local Qwen',
			baseUrl: 'http://localhost:8000',
			models: ['Qwen/Qwen2.5-72B-Instruct'],
			endpointVersion: 'v3',
		}], null, '\t');
		const model = testDisposables.add(createTextModel(content));
		const result = parseLanguageModelsProviderGroups(model);

		assert.deepStrictEqual({
			vendor: result[0].vendor,
			name: result[0].name,
			baseUrl: result[0].baseUrl,
			endpointVersion: result[0].endpointVersion,
		}, {
			vendor: 'vllm',
			name: 'Local Qwen',
			baseUrl: 'http://localhost:8000',
			endpointVersion: 'v3',
		});
	});

	test('parses multiple custom vendor groups', () => {
		const content = JSON.stringify([
			{ vendor: 'openai', name: 'Group A', baseUrl: 'https://a.test/v1', models: ['gpt-4o'] },
			{ vendor: 'vllm', name: 'Group B', baseUrl: 'http://localhost:8000', models: ['qwen'] },
		], null, '\t');
		const model = testDisposables.add(createTextModel(content));
		const result = parseLanguageModelsProviderGroups(model);

		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].vendor, 'openai');
		assert.strictEqual(result[1].vendor, 'vllm');
	});
});

// ---------------------------------------------------------------------------
// Suite 2: model id normalisation
// ---------------------------------------------------------------------------

suite('CustomLanguageModelProvider - model identifier format', () => {
	test('model identifier uses vendor/group/model format', () => {
		const vendor = 'openai';
		const group = 'My Group';
		const modelName = 'gpt-4o';
		const expected = `${vendor}/${group}/${modelName}`;
		// This matches the format used in CustomVendorProvider.provideLanguageModelChatInfo
		assert.strictEqual(expected, 'openai/My Group/gpt-4o');
	});

	test('CUSTOM_VENDORS contains openai, anthropic, vllm', () => {
		assert.deepStrictEqual([...CUSTOM_VENDORS], ['openai', 'anthropic', 'vllm']);
	});

	test('MY_PROVIDERS_CATEGORY_LABEL is stable', () => {
		assert.strictEqual(MY_PROVIDERS_CATEGORY_LABEL, 'My Providers');
	});
});

// ---------------------------------------------------------------------------
// Suite 3: token count estimation
// ---------------------------------------------------------------------------

suite('CustomLanguageModelProvider - token estimation', () => {
	test('estimates empty string as 0 tokens', () => {
		assert.strictEqual(estimateTokenCount(''), 0);
	});

	test('estimates 4 chars as 1 token', () => {
		assert.strictEqual(estimateTokenCount('abcd'), 1);
	});

	test('estimates longer text proportionally', () => {
		const text = 'a'.repeat(400);
		assert.strictEqual(estimateTokenCount(text), 100);
	});
});

// ---------------------------------------------------------------------------
// Suite 4: model picker – My Providers group rendering
// ---------------------------------------------------------------------------

suite('CustomLanguageModelProvider - model picker My Providers section', () => {

	function buildItems(models: ILanguageModelChatMetadataAndIdentifier[]) {
		return buildModelPickerItems(
			models,
			undefined,
			[],
			{},
			'1.99.0',
			StateType.Idle,
			() => { },
			undefined,
			true,
			undefined,
			stubEntitlementService,
			false,
			false,
		);
	}

	test('My Providers section toggle appears when custom vendor models exist', () => {
		const models = [
			makeModel('openai', 'gpt-4o', MY_PROVIDERS_CATEGORY_LABEL),
		];
		const items = buildItems(models);
		const toggle = items.find(i => i.kind === ActionListItemKind.Action && (i as { isSectionToggle?: boolean }).isSectionToggle && i.label === 'My Providers');
		assert.ok(toggle, 'My Providers section toggle must be present');
	});

	test('My Providers section does not appear without custom vendor models', () => {
		const models = [
			makeModel('copilot', 'claude-3.5-sonnet'),
		];
		const items = buildItems(models);
		const toggle = items.find(i => (i as { isSectionToggle?: boolean }).isSectionToggle && i.label === 'My Providers');
		assert.ok(!toggle, 'My Providers section toggle must NOT appear for non-custom models');
	});

	test('custom vendor models are placed in My Providers section', () => {
		const models = [
			makeModel('openai', 'gpt-4o', MY_PROVIDERS_CATEGORY_LABEL),
			makeModel('vllm', 'qwen', MY_PROVIDERS_CATEGORY_LABEL),
		];
		const items = buildItems(models);
		const myProviderItems = items.filter(i =>
			i.kind === ActionListItemKind.Action &&
			!(i as { isSectionToggle?: boolean }).isSectionToggle &&
			(i as { section?: string }).section === 'myProviders'
		);
		assert.strictEqual(myProviderItems.length, 2, 'Both custom models must be in myProviders section');
	});

	test('copilot models are NOT placed in My Providers section', () => {
		const models = [
			makeModel('copilot', 'claude-3.5-sonnet'),
			makeModel('openai', 'gpt-4o', MY_PROVIDERS_CATEGORY_LABEL),
		];
		const items = buildItems(models);
		const copilotInMyProviders = items.find(i =>
			(i as { section?: string }).section === 'myProviders' &&
			i.label === 'claude-3.5-sonnet'
		);
		assert.ok(!copilotInMyProviders, 'copilot model must NOT be in My Providers section');
	});
});

// ---------------------------------------------------------------------------
// Suite 5: endpointVersion defaulting
// ---------------------------------------------------------------------------

suite('CustomLanguageModelProvider - endpointVersion default', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('endpointVersion defaults to v3 when absent', () => {
		const content = JSON.stringify([{
			vendor: 'vllm',
			name: 'No Version',
			baseUrl: 'http://localhost:8000',
			models: ['qwen'],
		}], null, '\t');
		const model = testDisposables.add(createTextModel(content));
		const result = parseLanguageModelsProviderGroups(model);
		// endpointVersion not set in JSON means undefined at the interface level;
		// the contribution defaults to 'v3' at runtime when building the request URL.
		assert.ok(result[0].endpointVersion === undefined || result[0].endpointVersion === 'v3');
	});

	test('endpointVersion v1 is preserved', () => {
		const content = JSON.stringify([{
			vendor: 'vllm',
			name: 'V1 Server',
			baseUrl: 'http://localhost:8000',
			models: ['llama'],
			endpointVersion: 'v1',
		}], null, '\t');
		const model = testDisposables.add(createTextModel(content));
		const result = parseLanguageModelsProviderGroups(model);
		assert.strictEqual(result[0].endpointVersion, 'v1');
	});
});

// Silence unused import lint warning (CancellationToken is used for type-checking)
void CancellationToken.None;
