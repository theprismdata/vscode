/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IShellExecService = createDecorator<IShellExecService>('shellExecService');

export interface IShellExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface IShellExecService {
	readonly _serviceBrand: undefined;
	exec(command: string, cwd?: string): Promise<IShellExecResult>;
}
