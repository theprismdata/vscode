/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	IChatMessage,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatProvider,
	ILanguageModelChatResponse,
	ILanguageModelsService,
	IUserFriendlyLanguageModel,
} from '../common/languageModels.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../common/languageModelsConfiguration.js';
import { sendOpenAIChatRequest, validateOpenAIConfiguration, estimateTokenCount, ICustomLMValidationResult, IOpenAITool } from './adapters/openAIAdapter.js';
import { sendVllmChatRequest, validateVllmConfiguration } from './adapters/vllmAdapter.js';
import { sendAnthropicChatRequest, validateAnthropicConfiguration, ANTHROPIC_BASE_URL, IAnthropicTool } from './adapters/anthropicAdapter.js';
import { IWorkspaceFileIndexService, WorkspaceFileIndexService } from './adapters/workspaceFileIndexService.js';
import { IFilePathResolver, FilePathResolver } from './adapters/filePathResolver.js';

// ---------------------------------------------------------------------------
// Service interface for connection testing (used by chatModelsWidget)
// ---------------------------------------------------------------------------

export const ICustomLanguageModelProviderService = createDecorator<ICustomLanguageModelProviderService>('ICustomLanguageModelProviderService');

export interface ICustomLanguageModelProviderService {
	readonly _serviceBrand: undefined;
	/**
	 * Tests connectivity for a given provider group.
	 * Returns a validation result describing success or failure.
	 */
	testConnection(group: ILanguageModelsProviderGroup, token: CancellationToken): Promise<ICustomLMValidationResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic extension identifier for core-registered custom providers. */
const CUSTOM_LM_EXTENSION_ID = new ExtensionIdentifier('vscode.custom-language-models');

/** Model picker category label for user-defined providers. */
export const MY_PROVIDERS_CATEGORY_LABEL = 'My Providers';

/** Model picker category for user-defined providers. */
const MY_PROVIDERS_CATEGORY = { label: MY_PROVIDERS_CATEGORY_LABEL, order: 2 };

/**
 * Supported custom vendor identifiers.
 * These must be registered as vendor descriptors before any provider can be registered.
 */
export const CUSTOM_VENDORS = ['openai', 'anthropic', 'sonnet', 'vllm'] as const;
type CustomVendor = (typeof CUSTOM_VENDORS)[number];

// ---------------------------------------------------------------------------
// Internal model config cache entry
// ---------------------------------------------------------------------------

/** Default base URLs for managed vendors (no user-supplied baseUrl required). */
const VENDOR_DEFAULT_BASE_URLS: Partial<Record<CustomVendor, string>> = {
	openai: 'https://api.openai.com',
	anthropic: ANTHROPIC_BASE_URL,
	sonnet: ANTHROPIC_BASE_URL,
};

interface IResolvedModelConfig {
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly modelName: string;
	readonly groupName: string;
	readonly vendor: CustomVendor;
	readonly endpointVersion?: 'v1' | 'v3';
}

// ---------------------------------------------------------------------------
// Per-vendor provider
// ---------------------------------------------------------------------------

/**
 * A single ILanguageModelChatProvider that handles all user-defined groups for one vendor.
 * The service calls provideLanguageModelChatInfo once per group (with decoded configuration).
 * We cache modelId → connection details so sendChatRequest can route correctly.
 */
class CustomVendorProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Maps model identifier → resolved connection config. */
	private readonly _modelConfigs = new Map<string, IResolvedModelConfig>();

	constructor(
		private readonly _vendor: CustomVendor,
		private readonly _requestService: IRequestService,
		private readonly _logService: ILogService,
		private readonly _filePathResolver: IFilePathResolver | undefined,
	) { }

	async provideLanguageModelChatInfo(
		options: ILanguageModelChatInfoOptions,
		_token: CancellationToken
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {

		// Called without a group → no default models for custom vendors
		if (!options.group) {
			return [];
		}

		const configuration = options.configuration as IStringDictionary<unknown> | undefined;
		if (!configuration) {
			return [];
		}

		const configuredBaseUrl = typeof configuration['baseUrl'] === 'string' ? configuration['baseUrl'] : undefined;
		const baseUrl = configuredBaseUrl ?? VENDOR_DEFAULT_BASE_URLS[this._vendor];
		const apiKey = typeof configuration['apiKey'] === 'string' ? configuration['apiKey'] : undefined;
		const modelsValue = configuration['models'];
		const models: string[] = Array.isArray(modelsValue) ? modelsValue.filter(m => typeof m === 'string') : [];
		const defaultModel = typeof configuration['defaultModel'] === 'string' ? configuration['defaultModel'] : undefined;
		const endpointVersion = (configuration['endpointVersion'] === 'v1' ? 'v1' : 'v3') as 'v1' | 'v3';

		if (!baseUrl || models.length === 0) {
			this._logService.warn(`[CustomLM] Skipping group '${options.group}' for vendor '${this._vendor}': missing baseUrl or models`);
			return [];
		}

		const displayName = typeof configuration['displayName'] === 'string' ? configuration['displayName'] : options.group;
		const result: ILanguageModelChatMetadataAndIdentifier[] = [];

		for (const modelName of models) {
			const identifier = `${this._vendor}/${options.group}/${modelName}`;
			const config: IResolvedModelConfig = {
				baseUrl,
				apiKey,
				modelName,
				groupName: options.group,
				vendor: this._vendor,
				endpointVersion,
			};
			this._modelConfigs.set(identifier, config);

			result.push({
				identifier,
				metadata: {
					extension: CUSTOM_LM_EXTENSION_ID,
					name: modelName,
					id: `${options.group}/${modelName}`,
					vendor: this._vendor,
					version: '1',
					family: modelName,
					maxInputTokens: 128000,
					maxOutputTokens: 16384,
					isDefaultForLocation: {},
					isUserSelectable: true,
					modelPickerCategory: MY_PROVIDERS_CATEGORY,
					auth: { providerLabel: displayName },
					capabilities: { toolCalling: true },
				},
			});
		}

		// Ensure the defaultModel appears first in the list
		if (defaultModel) {
			const defaultIdx = result.findIndex(m => m.metadata.name === defaultModel);
			if (defaultIdx > 0) {
				const [item] = result.splice(defaultIdx, 1);
				result.unshift(item);
			}
		}

		return result;
	}

	async sendChatRequest(
		modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		options: { [name: string]: unknown },
		token: CancellationToken
	): Promise<ILanguageModelChatResponse> {

		const config = this._modelConfigs.get(modelId);
		if (!config) {
			throw new Error(`[CustomLM] No configuration found for model '${modelId}'`);
		}

		const tools = options['tools'] as IOpenAITool[] | undefined;

		if (config.vendor === 'vllm') {
			return sendVllmChatRequest(
				{ baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.modelName, endpointVersion: config.endpointVersion },
				messages,
				this._requestService,
				token,
				tools,
			);
		}

		if (config.vendor === 'anthropic' || config.vendor === 'sonnet') {
			const anthropicTools = options['anthropicTools'] as IAnthropicTool[] | undefined
				?? (tools ? this._convertToAnthropicTools(tools) : undefined);
			return sendAnthropicChatRequest(
				config.apiKey,
				config.modelName,
				messages,
				this._requestService,
				token,
				anthropicTools,
				this._filePathResolver,
			);
		}

		// openai: use OpenAI-native format with the default base URL
		return sendOpenAIChatRequest(
			{ baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.modelName },
			messages,
			this._requestService,
			token,
			tools,
		);
	}

	async provideTokenCount(
		_modelId: string,
		message: string | IChatMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof message === 'string') {
			return estimateTokenCount(message);
		}
		let total = 0;
		for (const part of message.content) {
			if (part.type === 'text') {
				total += estimateTokenCount(part.value);
			}
		}
		return total;
	}

	/** Converts OpenAI-format tools to Anthropic-format tools. */
	private _convertToAnthropicTools(tools: IOpenAITool[]): IAnthropicTool[] {
		return tools.map(t => ({
			name: t.function.name,
			description: t.function.description,
			input_schema: t.function.parameters,
		}));
	}

	/** Clears stale model configs and fires onDidChange so the service re-resolves models. */
	invalidate(): void {
		this._modelConfigs.clear();
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

// ---------------------------------------------------------------------------
// Main contribution + service implementation
// ---------------------------------------------------------------------------

/**
 * Workbench contribution that:
 * 1. Registers vendor descriptors for openai / anthropic / vllm (§5-1 Solution A).
 * 2. Registers one ILanguageModelChatProvider per vendor (§4-2 Vendor Aggregator).
 * 3. Reacts to group changes and invalidates providers so the model cache refreshes.
 *
 * Also implements ICustomLanguageModelProviderService for connection testing (§7-1).
 */
export class CustomLanguageModelProviderContribution extends Disposable implements IWorkbenchContribution, ICustomLanguageModelProviderService {

	static readonly ID = 'workbench.contrib.customLanguageModelProvider';

	declare readonly _serviceBrand: undefined;

	private readonly _providers = new Map<CustomVendor, CustomVendorProvider>();
	private readonly _providerRegistrations = new DisposableStore();

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly _languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceFileIndexService private readonly _fileIndexService: IWorkspaceFileIndexService,
		@IFilePathResolver private readonly _filePathResolver: IFilePathResolver,
	) {
		super();
		this._register(this._providerRegistrations);
		this._registerVendorDescriptors();
		this._registerVendorProviders();
		this._register(
			this._languageModelsConfigurationService.onDidChangeLanguageModelGroups(
				changedGroups => this._onGroupsChanged(changedGroups)
			)
		);
		// Initialize workspace file index in the background
		this._fileIndexService.initialize().catch(err =>
			this._logService.warn('[CustomLM] Failed to initialize workspace file index', err)
		);
	}

	// -------------------------------------------------------------------------
	// ICustomLanguageModelProviderService
	// -------------------------------------------------------------------------

	async testConnection(group: ILanguageModelsProviderGroup, token: CancellationToken): Promise<ICustomLMValidationResult> {
		const apiKey = group.apiKey;

		if (group.vendor === 'anthropic' || group.vendor === 'sonnet') {
			return validateAnthropicConfiguration(apiKey, this._requestService, token);
		}

		const baseUrl = group.baseUrl ?? VENDOR_DEFAULT_BASE_URLS[group.vendor as CustomVendor];
		if (!baseUrl) {
			return { ok: false, error: 'invalidResponse', message: 'No baseUrl configured for this provider group.' };
		}

		if (group.vendor === 'vllm') {
			return validateVllmConfiguration(baseUrl, apiKey, group.endpointVersion, this._requestService, token);
		}
		return validateOpenAIConfiguration(baseUrl, apiKey, this._requestService, token);
	}

	// -------------------------------------------------------------------------
	// Vendor descriptor registration (§5-1)
	// -------------------------------------------------------------------------

	private _registerVendorDescriptors(): void {
		// Schema for managed vendors (OpenAI, Anthropic) — base URL is fixed, not user-supplied
		const managedVendorSchema: IJSONSchema = {
			type: 'object',
			required: ['models'],
			properties: {
				displayName: { type: 'string', description: 'Display name shown in the model picker' },
				apiKey: { type: 'string', secret: true, description: 'API key (stored securely)' } as IJSONSchema,
				defaultModel: { type: 'string', description: 'Default model ID' },
				models: { type: 'array', items: { type: 'string' }, description: 'Available model IDs' },
			},
		};

		// Schema for vLLM — user must provide a custom base URL
		const vllmVendorSchema: IJSONSchema = {
			type: 'object',
			required: ['baseUrl', 'models'],
			properties: {
				displayName: { type: 'string', description: 'Display name shown in the model picker' },
				baseUrl: { type: 'string', description: 'API base URL (e.g. http://localhost:8000)' },
				apiKey: { type: 'string', secret: true, description: 'API key (stored securely, optional for local servers)' } as IJSONSchema,
				defaultModel: { type: 'string', description: 'Default model ID' },
				models: { type: 'array', items: { type: 'string' }, description: 'Available model IDs' },
				endpointVersion: { type: 'string', enum: ['v1', 'v3'], default: 'v1', description: 'Endpoint version (v1 for OpenAI-compatible)' },
			},
		};

		// IUserFriendlyLanguageModel['configuration'] is inferred as `undefined` by TypeFromJsonSchema
		// because the schema uses $ref-based anyOf which the type helper cannot resolve.
		// Cast through unknown to pass our IJSONSchema configuration correctly.
		const vendorDescriptors = [
			{ vendor: 'openai', displayName: 'OpenAI', configuration: managedVendorSchema },
			{ vendor: 'anthropic', displayName: 'Anthropic', configuration: managedVendorSchema },
			{ vendor: 'sonnet', displayName: 'Sonnet', configuration: managedVendorSchema },
			{ vendor: 'vllm', displayName: 'vLLM', configuration: vllmVendorSchema },
		] as unknown as IUserFriendlyLanguageModel[];

		const registeredVendors = new Set(this._languageModelsService.getVendors().map(v => v.vendor));
		const toAdd = vendorDescriptors.filter(v => !registeredVendors.has(v.vendor));
		if (toAdd.length > 0) {
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors(toAdd, []);
			this._logService.trace(`[CustomLM] Registered vendor descriptors: ${toAdd.map(v => v.vendor).join(', ')}`);
		}
	}

	// -------------------------------------------------------------------------
	// Provider registration (§4-2)
	// -------------------------------------------------------------------------

	private _registerVendorProviders(): void {
		const allGroups = this._languageModelsConfigurationService.getLanguageModelsProviderGroups();
		const registeredVendors = new Set(this._languageModelsService.getVendors().map(v => v.vendor));
		for (const vendor of CUSTOM_VENDORS) {
			if (!registeredVendors.has(vendor)) {
				this._logService.warn(`[CustomLM] Skipping provider registration for unknown vendor '${vendor}'`);
				continue;
			}
			const provider = new CustomVendorProvider(vendor, this._requestService, this._logService, this._filePathResolver);
			try {
				const registration: IDisposable = this._languageModelsService.registerLanguageModelProvider(vendor, provider);
				this._providers.set(vendor, provider);
				this._providerRegistrations.add(registration);
				this._providerRegistrations.add(provider);
				this._logService.trace(`[CustomLM] Registered provider for vendor '${vendor}'`);
				// If groups were already loaded before this provider was registered, trigger
				// an initial resolution by invalidating. This covers the startup timing gap where
				// onDidChangeLanguageModelGroups fires before the providers are registered.
				const hasGroupsForVendor = allGroups.some(g => g.vendor === vendor);
				if (hasGroupsForVendor) {
					this._logService.trace(`[CustomLM] Pre-existing groups for vendor '${vendor}', triggering initial resolution`);
					provider.invalidate();
				}
			} catch (err) {
				// Provider already registered by a prior instance (e.g. DI scope race) — safe to ignore
				this._logService.trace(`[CustomLM] Provider for vendor '${vendor}' already registered, skipping`);
				provider.dispose();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Group change handler (§7-3)
	// -------------------------------------------------------------------------

	private _onGroupsChanged(changedGroups: readonly ILanguageModelsProviderGroup[]): void {
		const affectedVendors = new Set(changedGroups.map(g => g.vendor));
		for (const vendor of affectedVendors) {
			if ((CUSTOM_VENDORS as readonly string[]).includes(vendor)) {
				const provider = this._providers.get(vendor as CustomVendor);
				if (provider) {
					this._logService.trace(`[CustomLM] Groups changed for vendor '${vendor}', invalidating provider cache`);
					provider.invalidate();
				}
			}
		}
	}
}

registerSingleton(ICustomLanguageModelProviderService, CustomLanguageModelProviderContribution, InstantiationType.Delayed);
registerSingleton(IWorkspaceFileIndexService, WorkspaceFileIndexService, InstantiationType.Delayed);
registerSingleton(IFilePathResolver, FilePathResolver, InstantiationType.Delayed);
