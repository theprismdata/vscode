/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../../base/common/uri.js';
import * as path from '../../../../../../../base/common/path.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IShellExecService, IShellExecResult } from '../../../../../../../platform/shell/common/shellExec.js';
import { IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, CountTokensCallback, ToolProgress } from '../../languageModelToolsService.js';

// ---------------------------------------------------------------------------
// Tool definition types
// ---------------------------------------------------------------------------

export type ToolSetType = 'read' | 'execute' | 'vscode' | 'agent';

export interface IIntelliCenToolServices {
	readonly fileService: IFileService;
	readonly workspaceService: IWorkspaceContextService;
	readonly shellExecService: IShellExecService;
	resolvePath(filePath: string): string;
	getWorkspaceRoot(): string;
}

export interface IIntelliCenToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly toolSet?: ToolSetType;
	readonly referenceName?: string;
	readonly parameters: Record<string, {
		type: string;
		required?: boolean;
		description: string;
		items?: { type: string };
	}>;
	invoke(params: Record<string, unknown>, services: IIntelliCenToolServices, token: CancellationToken): Promise<string>;
}

// ---------------------------------------------------------------------------
// Convert definition → IToolData
// ---------------------------------------------------------------------------

export function toToolData(def: IIntelliCenToolDefinition): IToolData {
	const required = Object.entries(def.parameters)
		.filter(([_, v]) => v.required)
		.map(([k]) => k);

	const properties: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(def.parameters)) {
		const prop: Record<string, unknown> = { type: val.type, description: val.description };
		if (val.items) {
			prop['items'] = val.items;
		}
		properties[key] = prop;
	}

	return {
		id: def.id,
		source: ToolDataSource.Internal,
		displayName: def.name,
		modelDescription: def.description,
		canBeReferencedInPrompt: true,
		toolReferenceName: def.referenceName,
		inputSchema: {
			type: 'object',
			required,
			properties,
		},
	};
}

// ---------------------------------------------------------------------------
// Convert definition → IToolImpl (runtime wrapper)
// ---------------------------------------------------------------------------

export class IntelliCenToolImpl implements IToolImpl {

	constructor(
		private readonly _def: IIntelliCenToolDefinition,
		private readonly _services: IIntelliCenToolServices,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const result = await this._def.invoke(invocation.parameters as Record<string, unknown>, this._services, token);
			return { content: [{ kind: 'text', value: result }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ kind: 'text', value: `Error: ${msg}` }], toolResultError: true };
		}
	}
}

// ---------------------------------------------------------------------------
// Services adapter (resolves DI services into simple interface)
// ---------------------------------------------------------------------------

export function createToolServices(
	fileService: IFileService,
	workspaceService: IWorkspaceContextService,
	shellExecService: IShellExecService,
): IIntelliCenToolServices {

	const getWorkspaceRoot = (): string => {
		const folders = workspaceService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri.fsPath;
		}
		try { return process.cwd(); } catch { return ''; }
	};

	const resolvePath = (filePath: string): string => {
		if (path.isAbsolute(filePath)) {
			return filePath;
		}
		const root = getWorkspaceRoot();
		return root ? path.join(root, filePath) : filePath;
	};

	return {
		fileService,
		workspaceService,
		shellExecService,
		resolvePath,
		getWorkspaceRoot,
	};
}
