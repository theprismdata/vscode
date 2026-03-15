/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIntelliCenToolDefinition } from './framework.js';

const runTerminalCommand: IIntelliCenToolDefinition = {
	id: 'intellicen_runTerminalCommand',
	name: 'Run Terminal Command',
	description: 'Execute a shell command and return its output. Runs in the workspace root. Use for git, npm, ls, cat, grep, ssh, build commands, etc.',
	toolSet: 'execute',
	referenceName: 'terminal',
	parameters: {
		command: { type: 'string', required: true, description: 'Shell command to execute' },
	},
	async invoke(params, services) {
		const command = params['command'] as string;
		if (!command) { throw new Error('command parameter is required'); }
		const cwd = services.getWorkspaceRoot() || undefined;
		const result = await services.shellExecService.exec(command, cwd);
		const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)';
		if (result.exitCode !== 0) {
			throw new Error(`Exit code ${result.exitCode}\n${output}`);
		}
		return output;
	},
};

export default runTerminalCommand;
