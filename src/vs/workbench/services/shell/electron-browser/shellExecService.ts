/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IShellExecService, IShellExecResult } from '../../../../platform/shell/common/shellExec.js';
import { ShellExecChannelClient } from '../../../../platform/shell/common/shellExecIpc.js';

class NativeShellExecService implements IShellExecService {
	declare readonly _serviceBrand: undefined;

	private readonly _client: ShellExecChannelClient;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
	) {
		this._client = new ShellExecChannelClient(sharedProcessService.getChannel('shellExec'));
	}

	exec(command: string, cwd?: string): Promise<IShellExecResult> {
		return this._client.exec(command, cwd);
	}
}

registerSingleton(IShellExecService, NativeShellExecService, InstantiationType.Delayed);
