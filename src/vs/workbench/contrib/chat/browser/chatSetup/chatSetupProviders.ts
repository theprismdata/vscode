/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatEntitlement, ChatEntitlementContext, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatModel, ChatRequestModel, IChatRequestModel, IChatRequestVariableData } from '../../common/model/chatModel.js';
import { ChatMode } from '../../common/chatModes.js';
import { ChatRequestAgentPart, ChatRequestToolPart } from '../../common/requestParser/chatParserTypes.js';
import { IChatProgress, IChatService } from '../../common/chatService/chatService.js';
import { IChatRequestToolEntry, IChatRequestVariableEntry, isStringImplicitContextValue } from '../../common/attachments/chatVariableEntries.js';
import { isLocation } from '../../../../../editor/common/languages.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';
import { CHAT_OPEN_ACTION_ID, CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';
import { toolDataToOpenAI, estimateTokenCount, IOpenAITool } from '../adapters/openAIAdapter.js';
import { ChatViewId, IChatWidgetService } from '../chat.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatViewPane } from '../widgetHosts/viewPane/chatViewPane.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CodeAction, CodeActionList, Command, NewSymbolName, NewSymbolNameTriggerKind } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ISelection, Selection } from '../../../../../editor/common/core/selection.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ChatSetupController } from './chatSetupController.js';
import { ChatSetupAnonymous, ChatSetupStep, IChatSetupResult, maybeEnableAuthExtension, refreshTokens } from './chatSetup.js';
import { ChatSetup } from './chatSetupRunner.js';
import { chatViewsWelcomeRegistry } from '../viewsWelcome/chatViewsWelcome.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	outputChannelId: product.defaultChatAgent?.chatExtensionOutputId ?? '',
	outputExtensionStateCommand: product.defaultChatAgent?.chatExtensionOutputExtensionStateCommand ?? '',
};

const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);

export class SetupAgent extends Disposable implements IChatAgentImplementation {

	static registerDefaultAgents(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let description;
			if (mode === ChatModeKind.Ask) {
				description = ChatMode.Ask.description.get();
			} else if (mode === ChatModeKind.Edit) {
				description = ChatMode.Edit.description.get();
			} else {
				description = ChatMode.Agent.description.get();
			}

			let id: string;
			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'setup.chat';
					} else if (mode === ChatModeKind.Edit) {
						id = 'setup.edits';
					} else {
						id = 'setup.agent';
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'setup.terminal';
					break;
				case ChatAgentLocation.EditorInline:
					id = 'setup.editor';
					break;
				case ChatAgentLocation.Notebook:
					id = 'setup.notebook';
					break;
			}

			return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, `${defaultChat.provider.default.name} Copilot` /* Do NOT change, this hides the username altogether in Chat */, true, description, location, mode, context, controller);
		});
	}

	static registerBuiltInAgents(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			const disposables = new DisposableStore();

			// Register VSCode agent
			const { disposable: vscodeDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.vscode', 'vscode', false, localize2('vscodeAgentDescription', "Ask questions about VS Code").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(vscodeDisposable);

			// Register workspace agent
			const { disposable: workspaceDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.workspace', 'workspace', false, localize2('workspaceAgentDescription', "Ask about your workspace").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(workspaceDisposable);

			// Register terminal agent
			const { disposable: terminalDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.terminal.agent', 'terminal', false, localize2('terminalAgentDescription', "Ask how to do something in the terminal").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(terminalDisposable);

			// Register tools
			disposables.add(SetupTool.registerTool(instantiationService, {
				id: 'setup_tools_createNewWorkspace',
				source: ToolDataSource.Internal,
				icon: Codicon.newFolder,
				displayName: localize('setupToolDisplayName', "New Workspace"),
				modelDescription: 'Scaffold a new workspace in VS Code',
				userDescription: localize('setupToolsDescription', "Scaffold a new workspace in VS Code"),
				canBeReferencedInPrompt: true,
				toolReferenceName: 'new',
				when: ContextKeyExpr.true(),
			}));

			return disposables;
		});
	}

	private static doRegisterAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, id: string, name: string, isDefault: boolean, description: string, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		const disposables = new DisposableStore();
		disposables.add(chatAgentService.registerAgent(id, {
			id,
			name,
			isDefault,
			isCore: true,
			modes: [mode],
			when: mode === ChatModeKind.Agent ? ToolsAgentContextKey?.serialize() : undefined,
			slashCommands: [],
			disambiguation: [],
			locations: [location],
			metadata: { helpTextPrefix: SetupAgent.SETUP_NEEDED_MESSAGE },
			description,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = disposables.add(instantiationService.createInstance(SetupAgent, context, controller, location));
		disposables.add(chatAgentService.registerAgentImplementation(id, agent));
		if (mode === ChatModeKind.Agent) {
			chatAgentService.updateAgent(id, { themeIcon: Codicon.tools });
		}

		return { agent, disposable: disposables };
	}

	private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpCopilotNeeded', "You need to set up GitHub Copilot and be signed in to use Chat."));
	private static readonly TRUST_NEEDED_MESSAGE = new MarkdownString(localize('trustNeeded', "You need to trust this workspace to use Chat."));

	private static readonly CHAT_RETRY_COMMAND_ID = 'workbench.action.chat.retrySetup';
	private static readonly CHAT_SHOW_OUTPUT_COMMAND_ID = 'workbench.action.chat.showOutput';

	private readonly _onUnresolvableError = this._register(new Emitter<void>());
	readonly onUnresolvableError = this._onUnresolvableError.event;

	private readonly pendingForwardedRequests = new ResourceMap<Promise<void>>();

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		private readonly location: ChatAgentLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IOutputService private readonly outputService: IOutputService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.registerCommands();
	}

	private registerCommands(): void {

		// Retry chat command
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_RETRY_COMMAND_ID, async (accessor, sessionResource: URI) => {
			const hostService = accessor.get(IHostService);
			const chatWidgetService = accessor.get(IChatWidgetService);

			const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
			await widget?.clear();

			hostService.reload();
		}));

		// Show output command: execute extension state command if available, then show output channel
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_SHOW_OUTPUT_COMMAND_ID, async (accessor) => {
			const commandService = accessor.get(ICommandService);

			if (defaultChat.outputExtensionStateCommand) {
				// Command invocation may fail or is blocked by the extension activating
				// so we just don't wait and timeout after a certain time, logging the error if it fails or times out.
				raceTimeout(
					commandService.executeCommand(defaultChat.outputExtensionStateCommand),
					5000,
					() => this.logService.info('[chat setup] Timed out executing extension state command')
				).then(undefined, error => {
					this.logService.info('[chat setup] Failed to execute extension state command', error);
				});
			}

			if (defaultChat.outputChannelId) {
				await commandService.executeCommand(`workbench.action.output.show.${defaultChat.outputChannelId}`);
			}
		}));
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void): Promise<IChatAgentResult> {
		return this.instantiationService.invokeFunction(async accessor /* using accessor for lazy loading */ => {
			const chatService = accessor.get(IChatService);
			const languageModelsService = accessor.get(ILanguageModelsService);
			const languageModelsConfigurationService = accessor.get(ILanguageModelsConfigurationService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatAgentService = accessor.get(IChatAgentService);
			const languageModelToolsService = accessor.get(ILanguageModelToolsService);
			const defaultAccountService = accessor.get(IDefaultAccountService);

			return this.doInvoke(request, part => progress([part]), chatService, languageModelsService, languageModelsConfigurationService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		});
	}

	private async doInvoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, languageModelsConfigurationService: ILanguageModelsConfigurationService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		// If the user explicitly selected a custom (non-Copilot) provider model, skip the Copilot
		// setup/sign-in flow entirely and go straight to inference.
		if (request.userSelectedModelId) {
			const modelMetadata = languageModelsService.lookupLanguageModel(request.userSelectedModelId);
			if (modelMetadata && ExtensionIdentifier.equals(modelMetadata.extension, 'vscode.custom-language-models')) {
				return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
			}
		}

		// If no model is selected yet, try to find a custom model in the cache.
		// This handles the startup race where the widget initializes before models resolve.
		if (!request.userSelectedModelId) {
			const customModelId = languageModelsService.getLanguageModelIds().find(id => {
				const m = languageModelsService.lookupLanguageModel(id);
				return m && ExtensionIdentifier.equals(m.extension, 'vscode.custom-language-models') && m.isUserSelectable;
			});
			if (customModelId) {
				return this.doInvokeWithoutSetup(
					{ ...request, userSelectedModelId: customModelId },
					progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService
				);
			}
		}

		// If custom provider groups are configured but models haven't resolved into the cache yet,
		// wait up to 8 seconds for the onDidChangeLanguageModels event before falling back.
		const configuredGroups = languageModelsConfigurationService.getLanguageModelsProviderGroups();
		if (configuredGroups.length > 0) {
			this.logService.warn(`[CustomLM] doInvoke: custom provider groups configured (${configuredGroups.length}), waiting for models to resolve...`);
			progress({
				kind: 'progressMessage',
				content: new MarkdownString(localize('customLMLoading', "Loading language models...")),
				shimmer: true,
			});
			const resolvedId = await new Promise<string | undefined>(resolve => {
				const check = () => languageModelsService.getLanguageModelIds().find(id => {
					const m = languageModelsService.lookupLanguageModel(id);
					return m && ExtensionIdentifier.equals(m.extension, 'vscode.custom-language-models') && m.isUserSelectable;
				});
				const immediate = check();
				if (immediate) { resolve(immediate); return; }
				const disposable = languageModelsService.onDidChangeLanguageModels(() => {
					const id = check();
					if (id) { disposable.dispose(); resolve(id); }
				});
				timeout(8000).then(() => { disposable.dispose(); resolve(undefined); });
			});
			if (resolvedId) {
				return this.doInvokeWithoutSetup(
					{ ...request, userSelectedModelId: resolvedId },
					progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService
				);
			}
			// Models never resolved — show a clear error instead of a sign-in dialog
			progress({
				kind: 'warning',
				content: new MarkdownString(localize('customLMTimeout', "Language models did not load in time. Check your provider settings and try again.")),
			});
			return {};
		}

		if (
			!this.context.state.installed ||									// Extension not installed: run setup to install
			this.context.state.disabled ||										// Extension disabled: run setup to enable
			this.context.state.untrusted ||										// Workspace untrusted: run setup to ask for trust
			this.context.state.entitlement === ChatEntitlement.Available ||		// Entitlement available: run setup to sign up
			(
				this.context.state.entitlement === ChatEntitlement.Unknown &&	// Entitlement unknown: run setup to sign in / sign up
				!this.chatEntitlementService.anonymous							// unless anonymous access is enabled
			)
		) {
			return this.doInvokeWithSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		}

		return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
	}

	private async doInvokeWithoutSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[chat setup] Request model not found, cannot redispatch request.');
			return {}; // this should not happen
		}

		// If the user selected a custom (non-Copilot) language model, stream directly from
		// the language model service. The SetupAgent's "forwarding" mechanism waits for a
		// non-core GitHub Copilot agent to register, which never happens without Copilot.
		// Going through chatService.resendRequest would also loop back to SetupAgent.
		if (request.userSelectedModelId) {
			const modelMetadata = languageModelsService.lookupLanguageModel(request.userSelectedModelId);
			if (modelMetadata && ExtensionIdentifier.equals(modelMetadata.extension, 'vscode.custom-language-models')) {
				// Build conversation history with system context
				const messages: IChatMessage[] = [];

				// System prompt with workspace info and tool instructions
				const workspaceFolders = this.instantiationService.invokeFunction(accessor =>
					accessor.get(IWorkspaceContextService).getWorkspace().folders
				);
				let workspacePath = workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
				if (!workspacePath) {
					try { workspacePath = process.cwd(); } catch { /* ignore */ }
				}
				const systemPrompt = [
					'You are IntelliCen Studio, an AI coding assistant integrated into the IDE.',
					workspacePath ? `WORKSPACE ROOT: ${workspacePath}` : '',
					'',
					'IMPORTANT RULES:',
					'1. You MUST use the provided tools to read files, list directories, and run commands.',
					'2. NEVER say "I cannot access files" — you CAN via tools.',
					workspacePath ? `3. For relative file paths, prepend the workspace root. Example: "product.json" → "${workspacePath}/product.json"` : '',
					workspacePath ? `4. To read "product.json", call intellicen_readFile with path="${workspacePath}/product.json"` : '',
					'5. To list project files, call intellicen_listDirectory with path="."',
					'6. To run shell commands, call intellicen_runTerminalCommand.',
					'7. After collecting all necessary information via tools, you MUST provide a final text answer summarizing your findings. Never end with only tool calls — always conclude with a text response.',
				].filter(Boolean).join('\n');
				messages.push({ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] });

				// Only include the most recent turns to avoid overflowing the context window.
				const MAX_HISTORY_TURNS = 6;
				// Assistant responses in history are capped to avoid re-injecting large tool outputs.
				const MAX_HISTORY_RESPONSE_CHARS = 2_000;

				const allRequests = widget?.viewModel?.model.getRequests() ?? [];
				const pastRequests: typeof allRequests = [];
				for (const req of allRequests) {
					if (req === requestModel) { break; }
					pastRequests.push(req);
				}
				const recentRequests = pastRequests.slice(-MAX_HISTORY_TURNS);
				for (const req of recentRequests) {
					messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: req.message.text }] });
					if (req.response) {
						let responseText = req.response.response.getMarkdown();
						if (responseText) {
							if (responseText.length > MAX_HISTORY_RESPONSE_CHARS) {
								responseText = responseText.slice(0, MAX_HISTORY_RESPONSE_CHARS) + '\n[... truncated for context ...]';
							}
							messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: responseText }] });
						}
					}
				}
				// Build user message with attached editor context (file selections, etc.)
				const userMessageParts: string[] = [];

				// Include attached context (e.g. editor selection) from request.variables
				const attachedContextText = this._buildAttachedContextText(request.variables, workspacePath);
				if (attachedContextText) {
					userMessageParts.push(attachedContextText);
				}
				userMessageParts.push(request.message);
				messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: userMessageParts.join('\n\n') }] });

				// Gather available tools — only include IntelliCen workspace tools
				const availableTools = languageModelToolsService.getTools(modelMetadata);
				const openAITools: IOpenAITool[] = [];
				for (const tool of availableTools) {
					if (tool.id.startsWith('intellicen_')) {
						openAITools.push(toolDataToOpenAI(tool));
					}
				}
				console.log(`[CustomLM] Tools available: ${openAITools.length}`, openAITools.map(t => t.function.name));

				const MAX_TOOL_ITERATIONS = 15;
				let summaryRequested = false;
				let hasStreamedText = false;
				try {
					for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
						const requestOptions: { [name: string]: unknown } = {};
						if (openAITools.length > 0) {
							requestOptions['tools'] = openAITools;
						}

					console.log(`[CustomLM][iter=${iteration}] Sending request — messages:`, messages.map(m => ({
						role: m.role,
						content: Array.isArray(m.content)
							? m.content.map(c => ({ type: (c as { type: string }).type, preview: 'value' in c ? String((c as { value: unknown }).value).slice(0, 120) : '(no value)' }))
							: String(m.content).slice(0, 120),
					})));

					const response = await languageModelsService.sendChatRequest(
						request.userSelectedModelId,
						undefined,
						messages,
						requestOptions,
						CancellationToken.None
					);

				const textParts: string[] = [];
					const toolUseParts: Array<{ type: 'tool_use'; name: string; toolCallId: string; parameters: Record<string, unknown> }> = [];

					// Tool calls cannot be streamed incrementally — we must buffer the full turn first.
					// Text-only turns are streamed to the UI in real time.

					for await (const part of response.stream) {
						const streamParts = Array.isArray(part) ? part : [part];
						for (const p of streamParts) {
							console.log(`[CustomLM][iter=${iteration}] stream chunk:`, JSON.stringify(p).slice(0, 300));
							if (p.type === 'text' && p.value) {
								textParts.push(p.value);
								// Stream text to UI immediately if no tool calls have arrived yet
								if (toolUseParts.length === 0) {
									progress({ kind: 'markdownContent', content: new MarkdownString(p.value) });
									hasStreamedText = true;
								}
							} else if (p.type === 'inlineReference') {
								// File path detected — emit as inline reference for InlineAnchorWidget rendering
								if (toolUseParts.length === 0) {
									progress({ kind: 'inlineReference', inlineReference: p.uri, name: p.name });
									hasStreamedText = true;
								}
							} else if (p.type === 'tool_use') {
								toolUseParts.push(p);
							}
						}
					}
					const resultValue = await response.result;
					console.log(`[CustomLM][iter=${iteration}] stream ended. result=`, resultValue);

					console.log(`[CustomLM][iter=${iteration}] summary — textParts=${textParts.length}, toolUseParts=${toolUseParts.length}`, toolUseParts.map(t => t.name));

					// No tool calls → text was already streamed (or there was none)
					if (toolUseParts.length === 0) {
						if (!hasStreamedText && textParts.length > 0) {
							// Fallback: output buffered text that wasn't streamed
							for (const text of textParts) {
								progress({ kind: 'markdownContent', content: new MarkdownString(text) });
							}
							break;
						}
						if (hasStreamedText) {
							break;
						}
						if (iteration > 0 && !summaryRequested) {
							// Model finished tool calls but returned no text — request an explicit summary once
							summaryRequested = true;
							messages.push({
								role: ChatMessageRole.User,
								content: [{ type: 'text', value: 'Based on the information you gathered with the tools, please provide your answer now.' }],
							});
							continue;
						}
						break;
					}

						// Safety: if near MAX_TOOL_ITERATIONS, request a final summary on next iteration
						if (iteration === MAX_TOOL_ITERATIONS - 2 && !summaryRequested) {
							summaryRequested = true;
							messages.push({
								role: ChatMessageRole.User,
								content: [{ type: 'text', value: 'You have used many tools. Please now provide your final answer based on everything you have gathered.' }],
							});
						}

						// Add assistant message with tool_use to conversation
						const assistantContent: IChatMessage['content'] = [];
						if (textParts.length > 0) {
							assistantContent.push({ type: 'text', value: textParts.join('') });
						}
						for (const tu of toolUseParts) {
							assistantContent.push({ type: 'tool_use', name: tu.name, toolCallId: tu.toolCallId, parameters: tu.parameters });
						}
						messages.push({ role: ChatMessageRole.Assistant, content: assistantContent });

						// Execute each tool (only if it's in our allowed list)
						const allowedToolIds = new Set(openAITools.map(t => t.function.name));
						for (const toolUse of toolUseParts) {
							// Skip hallucinated tool names
							if (!allowedToolIds.has(toolUse.name) && !allowedToolIds.has(toolUse.name.replace(/[^a-zA-Z0-9_-]/g, '_'))) {
								this.logService.warn(`[CustomLM] Skipping unknown tool: ${toolUse.name}`);
								messages.push({
									role: ChatMessageRole.User,
									content: [{
										type: 'tool_result',
										toolCallId: toolUse.toolCallId,
										value: [{ type: 'text', value: `Error: tool "${toolUse.name}" is not available. Available tools: ${Array.from(allowedToolIds).join(', ')}` }],
										isError: true,
									}],
								});
								continue;
							}
							progress({
								kind: 'progressMessage',
								content: new MarkdownString(localize('toolInvocation', "Running tool: {0}", toolUse.name)),
								shimmer: true,
							});

						const countTokens: CountTokensCallback = async (input: string) => estimateTokenCount(input);
						try {
							const toolResult = await languageModelToolsService.invokeTool({
								callId: toolUse.toolCallId,
								toolId: toolUse.name,
								parameters: toolUse.parameters,
								context: undefined,
							}, countTokens, CancellationToken.None);

							let resultText = toolResult.content
								.map(c => c.kind === 'text' ? c.value : '')
								.join('');

							// Cap tool results injected into the conversation to avoid
							// overflowing the model context window across iterations.
							const MAX_TOOL_RESULT_CHARS = 6_000;
							if (resultText.length > MAX_TOOL_RESULT_CHARS) {
								resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS)
									+ `\n[... truncated — ${resultText.length - MAX_TOOL_RESULT_CHARS} chars omitted. Use offset/limit params to read specific sections.]`;
							}

							messages.push({
								role: ChatMessageRole.User,
								content: [{
									type: 'tool_result',
									toolCallId: toolUse.toolCallId,
									value: [{ type: 'text', value: resultText || '(no output)' }],
									isError: !!toolResult.toolResultError,
								}],
							});
							} catch (toolErr) {
								this.logService.error(`[CustomLM] Tool ${toolUse.name} failed`, toolErr);
								messages.push({
									role: ChatMessageRole.User,
									content: [{
										type: 'tool_result',
										toolCallId: toolUse.toolCallId,
										value: [{ type: 'text', value: `Error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}` }],
										isError: true,
									}],
								});
							}
						}
					// Loop continues → send tool results back to the model
				}
				// If the loop completed without ever producing visible output, inform the user.
				if (!hasStreamedText) {
					progress({
						kind: 'warning',
						content: new MarkdownString(localize('customLMNoOutput', "The model did not return a response. The conversation context may be too large — try starting a new chat session.")),
					});
				}
			} catch (err) {
				this.logService.error('[CustomLM] Error invoking custom language model', err);
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('customLMError', "Failed to get a response from the custom language model. Please check your provider settings."))
				});
			}
				return {};
			}
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('waitingChat', "Getting chat ready")),
			shimmer: true,
		});

		await this.forwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);

		return {};
	}

	/**
	 * Builds a text representation of attached editor context (file selections, etc.)
	 * so that custom LM providers receive the context the user is referring to.
	 */
	private _buildAttachedContextText(variables: IChatRequestVariableData, workspacePath: string): string | undefined {
		if (!variables.variables || variables.variables.length === 0) {
			return undefined;
		}

		const contextParts: string[] = [];
		for (const variable of variables.variables) {
			const part = this._variableToContextText(variable, workspacePath);
			if (part) {
				contextParts.push(part);
			}
		}

		if (contextParts.length === 0) {
			return undefined;
		}

		return '[EDITOR CONTEXT]\n' + contextParts.join('\n\n');
	}

	private _variableToContextText(variable: IChatRequestVariableEntry, workspacePath: string): string | undefined {
		const toRelative = (fsPath: string) =>
			workspacePath && fsPath.startsWith(workspacePath)
				? fsPath.slice(workspacePath.length + 1)
				: fsPath;

		// File attached with a specific line range (e.g. #selection or dragged range)
		if (variable.kind === 'file' && isLocation(variable.value)) {
			const { uri, range } = variable.value;
			const rel = toRelative(uri.fsPath);
			const header = (range && !(range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn))
				? `File: ${rel} (lines ${range.startLineNumber}–${range.endLineNumber})`
				: `File: ${rel}`;
			const body = variable.modelDescription ? `\`\`\`\n${variable.modelDescription}\n\`\`\`` : '';
			return [header, body].filter(Boolean).join('\n');
		}

		// File attached without a specific range (whole-file reference)
		if (variable.kind === 'file' && URI.isUri(variable.value)) {
			const rel = toRelative((variable.value as URI).fsPath);
			const body = variable.modelDescription ? `\`\`\`\n${variable.modelDescription}\n\`\`\`` : '';
			return [`File: ${rel}`, body].filter(Boolean).join('\n');
		}

		// Implicit active-editor context: StringChatContextValue (has .value text + .uri)
		if (variable.kind === 'implicit' && isStringImplicitContextValue(variable.value)) {
			const rel = toRelative(variable.value.uri.fsPath);
			const displayName = variable.value.name ?? variable.name;
			const header = `Active editor: ${rel}${displayName ? ` (${displayName})` : ''}`;
			const body = variable.value.value ? `\`\`\`\n${variable.value.value}\n\`\`\`` : '';
			return [header, body].filter(Boolean).join('\n');
		}

		// Implicit context: URI only (active file, no selection text)
		if (variable.kind === 'implicit' && URI.isUri(variable.value)) {
			return `Active editor: ${toRelative((variable.value as URI).fsPath)}`;
		}

		// Implicit context: Location (active file with selection range)
		if (variable.kind === 'implicit' && isLocation(variable.value)) {
			const { uri, range } = variable.value as { uri: URI; range: { startLineNumber: number; endLineNumber: number } };
			const rel = toRelative(uri.fsPath);
			const body = variable.modelDescription ? `\`\`\`\n${variable.modelDescription}\n\`\`\`` : '';
			return [`Active editor: ${rel} (lines ${range.startLineNumber}–${range.endLineNumber})`, body].filter(Boolean).join('\n');
		}

		// Pasted code snippet
		if (variable.kind === 'paste') {
			const entry = variable as { kind: 'paste'; code: string; language: string; pastedLines: string };
			return `Pasted code (${entry.language || 'unknown'}):\n\`\`\`${entry.language || ''}\n${entry.code}\n\`\`\``;
		}

		// Generic string variable (e.g. #selection resolved to text)
		if (variable.kind === 'string' && typeof variable.value === 'string') {
			return `Context (${variable.name}): ${variable.value}`;
		}

		return undefined;
	}

	private async forwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		try {
			await this.doForwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		} catch (error) {
			this.logService.error('[chat setup] Failed to forward request to chat', error);

			progress({
				kind: 'warning',
				content: new MarkdownString(localize('copilotUnavailableWarning', "Failed to get a response. Please try again."))
			});
		}
	}

	private async doForwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (this.pendingForwardedRequests.has(requestModel.session.sessionResource)) {
			throw new Error('Request already in progress');
		}

		const forwardRequest = this.doForwardRequestToChatWhenReady(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		this.pendingForwardedRequests.set(requestModel.session.sessionResource, forwardRequest);

		try {
			await forwardRequest;
		} finally {
			this.pendingForwardedRequests.delete(requestModel.session.sessionResource);
		}
	}

	private async doForwardRequestToChatWhenReady(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {

		// Ensure auth extension is enabled before waiting for chat readiness.
		// This must run before the readiness event listeners are set up because
		// updateRunningExtensions restarts all extension hosts.
		const authExtensionReEnabled = await maybeEnableAuthExtension(this.extensionsWorkbenchService, this.logService);
		if (authExtensionReEnabled) {
			refreshTokens(this.commandService);
		}

		const widget = chatWidgetService.getWidgetBySessionResource(requestModel.session.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;

		// We need a signal to know when we can resend the request to
		// Chat. Waiting for the registration of the agent is not
		// enough, we also need a language/tools model to be available.

		let agentActivated = false;
		let agentReady = false;
		let languageModelReady = false;
		let toolsModelReady = false;

		const whenAgentActivated = this.whenAgentActivated(chatService).then(() => agentActivated = true);
		const whenAgentReady = this.whenAgentReady(chatAgentService, modeInfo?.kind)?.then(() => agentReady = true);
		if (!whenAgentReady) {
			agentReady = true;
		}
		const whenLanguageModelReady = this.whenLanguageModelReady(languageModelsService, requestModel.modelId)?.then(() => languageModelReady = true);
		if (!whenLanguageModelReady) {
			languageModelReady = true;
		}
		const whenToolsModelReady = this.whenToolsModelReady(languageModelToolsService, requestModel)?.then(() => toolsModelReady = true);
		if (!whenToolsModelReady) {
			toolsModelReady = true;
		}

		if (whenLanguageModelReady instanceof Promise || whenAgentReady instanceof Promise || whenToolsModelReady instanceof Promise) {
			const timeoutHandle = setTimeout(() => {
				progress({
					kind: 'progressMessage',
					content: new MarkdownString(localize('waitingChat2', "Chat is almost ready")),
					shimmer: true,
				});
			}, 10000);

			const disposables = new DisposableStore();
			disposables.add(toDisposable(() => clearTimeout(timeoutHandle)));
			try {
				const ready = await Promise.race([
					timeout(this.environmentService.remoteAuthority ? 60000 /* increase for remote scenarios */ : 20000).then(() => 'timedout'),
					this.whenPanelAgentHasGuidance(disposables).then(() => 'panelGuidance'),
					Promise.allSettled([
						whenAgentActivated,
						whenAgentReady,
						whenLanguageModelReady,
						whenToolsModelReady
					])
				]);

				if (ready === 'panelGuidance') {
					const warningMessage = localize('chatTookLongWarningExtension', "Please try again.");

					progress({
						kind: 'markdownContent',
						content: new MarkdownString(warningMessage)
					});

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}

				if (ready === 'timedout') {
					let warningMessage: string;
					if (this.chatEntitlementService.anonymous) {
						warningMessage = localize('chatTookLongWarningAnonymous', "Chat took too long to get ready. Please ensure that the extension `{0}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.chatExtensionId);
					} else {
						warningMessage = localize('chatTookLongWarning', "Chat took too long to get ready. Please ensure you are signed in to {0} and that the extension `{1}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.provider.default.name, defaultChat.chatExtensionId);
					}

					// Compute language model diagnostic info
					const languageModelIds = languageModelsService.getLanguageModelIds();
					let languageModelDefaultCount = 0;
					for (const id of languageModelIds) {
						const model = languageModelsService.lookupLanguageModel(id);
						if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
							languageModelDefaultCount++;
						}
					}

					// Compute agent diagnostic info
					const defaultAgent = chatAgentService.getDefaultAgent(this.location, modeInfo?.kind);
					const agentHasDefault = !!defaultAgent;
					const agentDefaultIsCore = defaultAgent?.isCore ?? false;
					const contributedDefaultAgent = chatAgentService.getContributedDefaultAgent(this.location);
					const agentHasContributedDefault = !!contributedDefaultAgent;
					const agentContributedDefaultIsCore = contributedDefaultAgent?.isCore ?? false;
					const agentActivatedCount = chatAgentService.getActivatedAgents().length;

					this.logService.warn(warningMessage, {
						agentActivated,
						agentReady,
						agentHasDefault,
						agentDefaultIsCore,
						agentHasContributedDefault,
						agentContributedDefaultIsCore,
						agentActivatedCount,
						agentLocation: this.location,
						agentModeKind: modeInfo?.kind,
						languageModelReady,
						languageModelCount: languageModelIds.length,
						languageModelDefaultCount,
						languageModelHasRequestedModel: !!requestModel.modelId,
						toolsModelReady
					});

					type ChatSetupTimeoutClassification = {
						owner: 'chrmarti';
						comment: 'Provides insight into chat setup timeouts.';
						agentActivated: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was activated.' };
						agentReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was ready.' };
						agentHasDefault: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a default agent exists for the location and mode.' };
						agentDefaultIsCore: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the default agent is a core agent.' };
						agentHasContributedDefault: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a contributed default agent exists for the location.' };
						agentContributedDefaultIsCore: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the contributed default agent is a core agent.' };
						agentActivatedCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of activated agents at timeout.' };
						agentLocation: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The chat agent location.' };
						agentModeKind: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The chat mode kind.' };
						languageModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the language model was ready.' };
						languageModelCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of registered language models at timeout.' };
						languageModelDefaultCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of language models with isDefaultForLocation[Chat] set.' };
						languageModelHasRequestedModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a specific model ID was requested.' };
						toolsModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the tools model was ready.' };
						isRemote: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether this is a remote scenario.' };
						isAnonymous: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether anonymous access is enabled.' };
						matchingWelcomeViewWhen: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The when clause of the matching extension welcome view, if any.' };
					};
					type ChatSetupTimeoutEvent = {
						agentActivated: boolean;
						agentReady: boolean;
						agentHasDefault: boolean;
						agentDefaultIsCore: boolean;
						agentHasContributedDefault: boolean;
						agentContributedDefaultIsCore: boolean;
						agentActivatedCount: number;
						agentLocation: string;
						agentModeKind: string;
						languageModelReady: boolean;
						languageModelCount: number;
						languageModelDefaultCount: number;
						languageModelHasRequestedModel: boolean;
						toolsModelReady: boolean;
						isRemote: boolean;
						isAnonymous: boolean;
						matchingWelcomeViewWhen: string;
					};
					const chatViewPane = this.viewsService.getActiveViewWithId(ChatViewId) as ChatViewPane | undefined;
					const matchingWelcomeView = chatViewPane?.getMatchingWelcomeView();

					this.telemetryService.publicLog2<ChatSetupTimeoutEvent, ChatSetupTimeoutClassification>('chatSetup.timeout', {
						agentActivated,
						agentReady,
						agentHasDefault,
						agentDefaultIsCore,
						agentHasContributedDefault,
						agentContributedDefaultIsCore,
						agentActivatedCount,
						agentLocation: this.location,
						agentModeKind: modeInfo?.kind ?? '',
						languageModelReady,
						languageModelCount: languageModelIds.length,
						languageModelDefaultCount,
						languageModelHasRequestedModel: !!requestModel.modelId,
						toolsModelReady,
						isRemote: !!this.environmentService.remoteAuthority,
						isAnonymous: this.chatEntitlementService.anonymous,
						matchingWelcomeViewWhen: matchingWelcomeView?.when.serialize() ?? (chatViewPane ? 'noWelcomeView' : 'noChatViewPane'),
					});

					progress({
						kind: 'warning',
						content: new MarkdownString(warningMessage)
					});

					if (defaultChat.outputChannelId && this.outputService.getChannelDescriptor(defaultChat.outputChannelId)) {
						progress({
							kind: 'command',
							command: {
								id: SetupAgent.CHAT_SHOW_OUTPUT_COMMAND_ID,
								title: localize('showCopilotChatDetails', "Show Details")
							}
						});
					} else {
						this.logService.warn(defaultChat.outputChannelId
							? `[chat setup] No output channel found for id '${defaultChat.outputChannelId}' to show details about chat setup timeout. Please ensure the ${defaultChat.chatExtensionId} extension is activated.`
							: '[chat setup] No output channel provided via product.json to show details about chat setup timeout.');
						progress({
							kind: 'command',
							command: {
								id: SetupAgent.CHAT_RETRY_COMMAND_ID,
								title: localize('retryChat', "Restart"),
								arguments: [requestModel.session.sessionResource]
							}
						});
					}

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}
			} finally {
				disposables.dispose();
			}
		}

		await chatService.resendRequest(requestModel, {
			...widget?.getModeRequestOptions(),
			modeInfo,
			userSelectedModelId: widget?.input.currentLanguageModel
		});
	}

	private async whenPanelAgentHasGuidance(disposables: DisposableStore): Promise<void> {
		const panelAgentHasGuidance = () => chatViewsWelcomeRegistry.get().some(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));

		if (panelAgentHasGuidance()) {
			return;
		}

		return new Promise<void>(resolve => {
			let descriptorKeys: Set<string> = new Set();
			const updateDescriptorKeys = () => {
				const descriptors = chatViewsWelcomeRegistry.get();
				descriptorKeys = new Set(descriptors.flatMap(d => d.when.keys()));
			};
			updateDescriptorKeys();

			const onDidChangeRegistry = Event.map(chatViewsWelcomeRegistry.onDidChange, () => 'registry' as const);
			const onDidChangeRelevantContext = Event.map(
				Event.filter(this.contextKeyService.onDidChangeContext, e => e.affectsSome(descriptorKeys)),
				() => 'context' as const
			);

			disposables.add(Event.any(
				onDidChangeRegistry,
				onDidChangeRelevantContext
			)(source => {
				if (source === 'registry') {
					updateDescriptorKeys();
				}
				if (panelAgentHasGuidance()) {
					resolve();
				}
			}));
		});
	}

	private whenLanguageModelReady(languageModelsService: ILanguageModelsService, modelId: string | undefined): Promise<unknown> | void {
		const hasModelForRequest = () => {
			if (modelId) {
				return !!languageModelsService.lookupLanguageModel(modelId);
			}

			for (const id of languageModelsService.getLanguageModelIds()) {
				const model = languageModelsService.lookupLanguageModel(id);
				if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
					return true;
				}
			}

			return false;
		};

		if (hasModelForRequest()) {
			return;
		}

		return Event.toPromise(Event.filter(languageModelsService.onDidChangeLanguageModels, () => hasModelForRequest()));
	}

	private whenToolsModelReady(languageModelToolsService: ILanguageModelToolsService, requestModel: IChatRequestModel): Promise<unknown> | void {
		const needsToolsModel = requestModel.message.parts.some(part => part instanceof ChatRequestToolPart);
		if (!needsToolsModel) {
			return; // No tools in this request, no need to check
		}

		// check that tools other than setup. and internal tools are registered.
		for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
			if (tool.id.startsWith('copilot_')) {
				return; // we have tools!
			}
		}

		return Event.toPromise(Event.filter(languageModelToolsService.onDidChangeTools, () => {
			for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
				if (tool.id.startsWith('copilot_')) {
					return true; // we have tools!
				}
			}

			return false; // no external tools found
		}));
	}

	private whenAgentReady(chatAgentService: IChatAgentService, mode: ChatModeKind | undefined): Promise<unknown> | void {
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
		if (defaultAgent && !defaultAgent.isCore) {
			return; // we have a default agent from an extension!
		}

		return Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
			return Boolean(defaultAgent && !defaultAgent.isCore);
		}));
	}

	private async whenAgentActivated(chatService: IChatService): Promise<void> {
		try {
			await chatService.activateDefaultAgent(this.location);
		} catch (error) {
			this.logService.error(error);
		}
	}

	private async doInvokeWithSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: CHAT_SETUP_ACTION_ID, from: 'chat' });

		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);

		const setupListener = Event.runAndSubscribe(this.controller.value.onDidChange, (() => {
			switch (this.controller.value.step) {
				case ChatSetupStep.SigningIn:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('setupChatSignIn2', "Signing in to {0}", defaultAccountService.getDefaultAccountAuthenticationProvider().name)),
						shimmer: true,
					});
					break;
				case ChatSetupStep.Installing:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('installingChat', "Getting chat ready")),
						shimmer: true,
					});
					break;
			}
		}));

		let result: IChatSetupResult | undefined = undefined;
		try {
			result = await ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				disableChatViewReveal: true, 																				// we are already in a chat context
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithoutDialog : undefined	// only enable anonymous selectively
			});
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
		} finally {
			setupListener.dispose();
		}

		// User has agreed to run the setup
		if (typeof result?.success === 'boolean') {
			if (result.success) {
				if (result.dialogSkipped) {
					await widget?.clear(); // make room for the Chat welcome experience
				} else if (requestModel) {
					let newRequest = this.replaceAgentInRequestModel(requestModel, chatAgentService); 	// Replace agent part with the actual Chat agent...
					newRequest = this.replaceToolInRequestModel(newRequest); 							// ...then replace any tool parts with the actual Chat tools

					await this.forwardRequestToChat(newRequest, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
				}
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('chatSetupError', "Chat setup failed."))
				});
			}
		}

		// User has cancelled the setup
		else {
			progress({
				kind: 'markdownContent',
				content: this.workspaceTrustManagementService.isWorkspaceTrusted() ? SetupAgent.SETUP_NEEDED_MESSAGE : SetupAgent.TRUST_NEEDED_MESSAGE
			});
		}

		return {};
	}

	private replaceAgentInRequestModel(requestModel: IChatRequestModel, chatAgentService: IChatAgentService): IChatRequestModel {
		const agentPart = requestModel.message.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		if (!agentPart) {
			return requestModel;
		}

		const agentId = agentPart.agent.id.replace(/setup\./, `${defaultChat.extensionId}.`.toLowerCase());
		const githubAgent = chatAgentService.getAgent(agentId);
		if (!githubAgent) {
			return requestModel;
		}

		const newAgentPart = new ChatRequestAgentPart(agentPart.range, agentPart.editorRange, githubAgent);

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestAgentPart) {
						return newAgentPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: requestModel.variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: requestModel.attachedContext,
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private replaceToolInRequestModel(requestModel: IChatRequestModel): IChatRequestModel {
		const toolPart = requestModel.message.parts.find((r): r is ChatRequestToolPart => r instanceof ChatRequestToolPart);
		if (!toolPart) {
			return requestModel;
		}

		const toolId = toolPart.toolId.replace(/setup.tools\./, `copilot_`.toLowerCase());
		const newToolPart = new ChatRequestToolPart(
			toolPart.range,
			toolPart.editorRange,
			toolPart.toolName,
			toolId,
			toolPart.displayName,
			toolPart.icon
		);

		const chatRequestToolEntry: IChatRequestToolEntry = {
			id: toolId,
			name: 'new',
			range: toolPart.range,
			kind: 'tool',
			value: undefined
		};

		const variableData: IChatRequestVariableData = {
			variables: [chatRequestToolEntry]
		};

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestToolPart) {
						return newToolPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: [chatRequestToolEntry],
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}
}

export class SetupTool implements IToolImpl {

	static registerTool(instantiationService: IInstantiationService, toolData: IToolData): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const toolService = accessor.get(ILanguageModelToolsService);

			const tool = instantiationService.createInstance(SetupTool);
			return toolService.registerTool(toolData, tool);
		});
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result: IToolResult = {
			content: [
				{
					kind: 'text',
					value: ''
				}
			]
		};

		return result;
	}

	async prepareToolInvocation?(parameters: unknown, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class AINewSymbolNamesProvider {

	static registerProvider(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(AINewSymbolNamesProvider, context, controller);
			return languageFeaturesService.newSymbolNamesProvider.register('*', provider);
		});
	}

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
	}

	async provideNewSymbolNames(model: ITextModel, range: IRange, triggerKind: NewSymbolNameTriggerKind, token: CancellationToken): Promise<NewSymbolName[] | undefined> {
		await this.instantiationService.invokeFunction(accessor => {
			return ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithDialog : undefined
			});
		});

		return [];
	}
}

export class ChatCodeActionsProvider {

	static registerProvider(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(ChatCodeActionsProvider);
			return languageFeaturesService.codeActionProvider.register('*', provider);
		});
	}

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
	}

	async provideCodeActions(model: ITextModel, range: Range | Selection): Promise<CodeActionList | undefined> {
		const actions: CodeAction[] = [];

		// "Generate" if the line is whitespace only
		// "Modify" if there is a selection
		let generateOrModifyTitle: string | undefined;
		let generateOrModifyCommand: Command | undefined;
		if (range.isEmpty()) {
			const textAtLine = model.getLineContent(range.startLineNumber);
			if (/^\s*$/.test(textAtLine)) {
				generateOrModifyTitle = localize('generate', "Generate");
				generateOrModifyCommand = AICodeActionsHelper.generate(range);
			}
		} else {
			const textInSelection = model.getValueInRange(range);
			if (!/^\s*$/.test(textInSelection)) {
				generateOrModifyTitle = localize('modify', "Modify");
				generateOrModifyCommand = AICodeActionsHelper.modify(range);
			}
		}

		if (generateOrModifyTitle && generateOrModifyCommand) {
			actions.push({
				kind: CodeActionKind.RefactorRewrite.append('copilot').value,
				isAI: true,
				title: generateOrModifyTitle,
				command: generateOrModifyCommand,
			});
		}

		const markers = AICodeActionsHelper.warningOrErrorMarkersAtRange(this.markerService, model.uri, range);
		if (markers.length > 0) {

			// "Fix" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('fix', "Fix"),
				command: AICodeActionsHelper.fixMarkers(markers, range)
			});

			// "Explain" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('explain').append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('explain', "Explain"),
				command: AICodeActionsHelper.explainMarkers(markers)
			});
		}

		return {
			actions,
			dispose() { }
		};
	}
}

export class AICodeActionsHelper {

	static warningOrErrorMarkersAtRange(markerService: IMarkerService, resource: URI, range: Range | Selection): IMarker[] {
		return markerService
			.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning })
			.filter(marker => range.startLineNumber <= marker.endLineNumber && range.endLineNumber >= marker.startLineNumber);
	}

	static modify(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('modify', "Modify"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	static generate(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('generate', "Generate"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	private static rangeToSelection(range: Range): ISelection {
		return new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	static explainMarkers(markers: IMarker[]): Command {
		return {
			id: CHAT_OPEN_ACTION_ID,
			title: localize('explain', "Explain"),
			arguments: [
				{
					query: `@workspace /explain ${markers.map(marker => marker.message).join(', ')}`,
					isPartialQuery: true
				} satisfies { query: string; isPartialQuery: boolean }
			]
		};
	}

	static fixMarkers(markers: IMarker[], range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('fix', "Fix"),
			arguments: [
				{
					message: `/fix ${markers.map(marker => marker.message).join(', ')}`,
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { message: string; initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}
}
