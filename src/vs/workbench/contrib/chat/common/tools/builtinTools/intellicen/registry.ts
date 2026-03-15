/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IShellExecService } from '../../../../../../../platform/shell/common/shellExec.js';
import { ILanguageModelToolsService } from '../../languageModelToolsService.js';
import { IIntelliCenToolDefinition, IntelliCenToolImpl, toToolData, createToolServices, ToolSetType } from './framework.js';

// ---- Import all tool definitions here ----
import readFile from './readFile.js';
import listDirectory from './listDirectory.js';
import runTerminalCommand from './runTerminalCommand.js';
import searchFiles from './searchFiles.js';

/** All IntelliCen tools — add new tools to this array */
const ALL_TOOLS: IIntelliCenToolDefinition[] = [
	readFile,
	listDirectory,
	runTerminalCommand,
	searchFiles,
];

// ---------------------------------------------------------------------------
// Register all tools
// ---------------------------------------------------------------------------

export function registerIntelliCenTools(
	disposables: Disposable,
	toolsService: ILanguageModelToolsService,
	fileService: IFileService,
	workspaceService: IWorkspaceContextService,
	shellExecService: IShellExecService,
): void {
	const services = createToolServices(fileService, workspaceService, shellExecService);

	const toolSetMap: Record<ToolSetType, ReturnType<typeof toolsService.readToolSet.addTool> extends infer R ? (data: Parameters<typeof toolsService.readToolSet.addTool>[0]) => R : never> = {
		read: (data) => toolsService.readToolSet.addTool(data),
		execute: (data) => toolsService.executeToolSet.addTool(data),
		vscode: (data) => toolsService.vscodeToolSet.addTool(data),
		agent: (data) => toolsService.agentToolSet.addTool(data),
	};

	for (const def of ALL_TOOLS) {
		const toolData = toToolData(def);
		const toolImpl = new IntelliCenToolImpl(def, services);
		disposables['_register'](toolsService.registerTool(toolData, toolImpl));
		if (def.toolSet && toolSetMap[def.toolSet]) {
			disposables['_register'](toolSetMap[def.toolSet](toolData));
		}
	}
}
