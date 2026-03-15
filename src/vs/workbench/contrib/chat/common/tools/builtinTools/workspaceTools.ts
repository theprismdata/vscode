/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IShellExecService } from '../../../../../../platform/shell/common/shellExec.js';
import { CountTokensCallback, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';
import * as path from '../../../../../../base/common/path.js';

// ---------------------------------------------------------------------------
// Helper: resolve relative paths against workspace root
// ---------------------------------------------------------------------------

function getWorkspaceRoot(workspaceService: IWorkspaceContextService): string {
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length > 0) {
		return folders[0].uri.fsPath;
	}
	// Fallback: use IWorkspaceContextService cwd or a known default
	return '';
}

function resolveWorkspacePath(filePath: string, workspaceService: IWorkspaceContextService): string {
	if (path.isAbsolute(filePath)) {
		return filePath;
	}
	const root = getWorkspaceRoot(workspaceService);
	if (root) {
		return path.join(root, filePath);
	}
	// No workspace open — try cwd via environment
	try {
		return path.join(process.cwd(), filePath);
	} catch {
		return filePath;
	}
}

// ---------------------------------------------------------------------------
// 1. Read File Tool
// ---------------------------------------------------------------------------

export const ReadFileToolData: IToolData = {
	id: 'intellicen_readFile',
	source: ToolDataSource.Internal,
	displayName: localize('readFile.displayName', "Read File"),
	modelDescription: 'Read the contents of a file. Accepts absolute or workspace-relative paths. Returns the file text content.',
	canBeReferencedInPrompt: true,
	toolReferenceName: 'readFile',
	inputSchema: {
		type: 'object',
		required: ['path'],
		properties: {
			path: {
				type: 'string',
				description: 'File path (absolute or relative to workspace root)',
			},
		},
	},
};

export class ReadFileTool implements IToolImpl {

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const filePath = invocation.parameters['path'] as string;
		if (!filePath) {
			return { content: [{ kind: 'text', value: 'Error: path parameter is required' }], toolResultError: true };
		}

		try {
			const resolved = resolveWorkspacePath(filePath, this._workspaceService);
			const uri = URI.file(resolved);
			const content = await this._fileService.readFile(uri, undefined, token);
			return {
				content: [{ kind: 'text', value: content.value.toString() }],
			};
		} catch (err) {
			return {
				content: [{ kind: 'text', value: `Error reading file '${filePath}': ${err instanceof Error ? err.message : String(err)}` }],
				toolResultError: true,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// 2. List Directory Tool
// ---------------------------------------------------------------------------

export const ListDirectoryToolData: IToolData = {
	id: 'intellicen_listDirectory',
	source: ToolDataSource.Internal,
	displayName: localize('listDir.displayName', "List Directory"),
	modelDescription: 'List files and subdirectories. Accepts absolute or workspace-relative paths. Use "." for workspace root. Returns names with [FILE] or [DIR] prefixes.',
	canBeReferencedInPrompt: true,
	toolReferenceName: 'ls',
	inputSchema: {
		type: 'object',
		required: ['path'],
		properties: {
			path: {
				type: 'string',
				description: 'Directory path (absolute or relative to workspace root, use "." for root)',
			},
		},
	},
};

export class ListDirectoryTool implements IToolImpl {

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const dirPath = invocation.parameters['path'] as string;
		if (!dirPath) {
			return { content: [{ kind: 'text', value: 'Error: path parameter is required' }], toolResultError: true };
		}

		try {
			const resolved = resolveWorkspacePath(dirPath, this._workspaceService);
			const uri = URI.file(resolved);
			const stat = await this._fileService.resolve(uri);
			if (!stat.children) {
				return { content: [{ kind: 'text', value: `${dirPath} is not a directory or is empty` }] };
			}

			const lines = stat.children.map(child => {
				const prefix = child.isDirectory ? '[DIR]' : '[FILE]';
				return `${prefix} ${child.name}`;
			});
			return {
				content: [{ kind: 'text', value: lines.join('\n') }],
			};
		} catch (err) {
			return {
				content: [{ kind: 'text', value: `Error listing directory '${dirPath}': ${err instanceof Error ? err.message : String(err)}` }],
				toolResultError: true,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// 3. Search Files (Grep) Tool
// ---------------------------------------------------------------------------

export const SearchFilesToolData: IToolData = {
	id: 'intellicen_searchFiles',
	source: ToolDataSource.Internal,
	displayName: localize('searchFiles.displayName', "Search Files"),
	modelDescription: 'Search for a text pattern across files in the workspace. Use the intellicen_runTerminalCommand tool with grep or find commands for full search capability.',
	canBeReferencedInPrompt: true,
	toolReferenceName: 'grep',
	inputSchema: {
		type: 'object',
		required: ['pattern'],
		properties: {
			pattern: {
				type: 'string',
				description: 'Search pattern (supports regex)',
			},
			path: {
				type: 'string',
				description: 'Directory to search in (defaults to workspace root)',
			},
		},
	},
};

export class SearchFilesTool implements IToolImpl {

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const pattern = invocation.parameters['pattern'] as string;
		if (!pattern) {
			return { content: [{ kind: 'text', value: 'Error: pattern parameter is required' }], toolResultError: true };
		}

		const searchPath = invocation.parameters['path'] as string || '.';
		const resolved = resolveWorkspacePath(searchPath, this._workspaceService);

		return {
			content: [{ kind: 'text', value: `To search for "${pattern}" in "${resolved}", use the intellicen_runTerminalCommand tool with: grep -rn "${pattern}" "${resolved}" --include="*.ts" | head -30` }],
		};
	}
}

// ---------------------------------------------------------------------------
// 4. Run Terminal Command Tool
// ---------------------------------------------------------------------------

export const RunTerminalCommandToolData: IToolData = {
	id: 'intellicen_runTerminalCommand',
	source: ToolDataSource.Internal,
	displayName: localize('runCommand.displayName', "Run Terminal Command"),
	modelDescription: 'Execute a shell command and return its output. The command runs in the workspace root directory. Use for: git, npm, ls, cat, grep, build commands, etc.',
	canBeReferencedInPrompt: true,
	toolReferenceName: 'terminal',
	inputSchema: {
		type: 'object',
		required: ['command'],
		properties: {
			command: {
				type: 'string',
				description: 'Shell command to execute',
			},
		},
	},
};

export class RunTerminalCommandTool implements IToolImpl {

	constructor(
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IShellExecService private readonly _shellExecService: IShellExecService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const command = invocation.parameters['command'] as string;
		if (!command) {
			return { content: [{ kind: 'text', value: 'Error: command parameter is required' }], toolResultError: true };
		}

		const folders = this._workspaceService.getWorkspace().folders;
		const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

		try {
			console.log(`[RunTerminalCommand] Executing: "${command}" in cwd: "${cwd}"`);
			const result = await this._shellExecService.exec(command, cwd);
			console.log(`[RunTerminalCommand] Result: exitCode=${result.exitCode}, stdout=${result.stdout.length} chars, stderr=${result.stderr.length} chars`);
			const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)';
			return {
				content: [{ kind: 'text', value: output }],
				toolResultError: result.exitCode !== 0 ? true : undefined,
			};
		} catch (err) {
			console.error(`[RunTerminalCommand] Error:`, err);
			return {
				content: [{ kind: 'text', value: `Command execution error: ${err instanceof Error ? err.stack || err.message : String(err)}` }],
				toolResultError: true,
			};
		}
	}
}
