/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IShellExecResult, IShellExecService } from './shellExec.js';

export class ShellExecChannel implements IServerChannel {
	constructor(private readonly service: IShellExecService) { }

	listen(_context: unknown, _event: string): never {
		throw new Error('No events');
	}

	call(_context: unknown, command: string, args: unknown[]): Promise<unknown> {
		switch (command) {
			case 'exec': return this.service.exec(args[0] as string, args[1] as string | undefined);
		}
		throw new Error(`Unknown command: ${command}`);
	}
}

export class ShellExecChannelClient implements IShellExecService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly channel: IChannel) { }

	exec(command: string, cwd?: string): Promise<IShellExecResult> {
		return this.channel.call('exec', [command, cwd]);
	}
}
