/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { IShellExecResult, IShellExecService } from '../common/shellExec.js';

export class ShellExecService implements IShellExecService {
	declare readonly _serviceBrand: undefined;

	async exec(command: string, cwd?: string): Promise<IShellExecResult> {
		return new Promise<IShellExecResult>((resolve) => {
			cp.exec(command, { timeout: 60000, maxBuffer: 2 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
				resolve({
					stdout: stdout || '',
					stderr: stderr || '',
					exitCode: error ? error.code ?? 1 : 0,
				});
			});
		});
	}
}
