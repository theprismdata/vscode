/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { IIntelliCenToolDefinition } from './framework.js';

const listDirectory: IIntelliCenToolDefinition = {
	id: 'intellicen_listDirectory',
	name: 'List Directory',
	description: 'List files and subdirectories. Use "." for workspace root. Returns names with [FILE] or [DIR] prefixes.',
	toolSet: 'read',
	referenceName: 'ls',
	parameters: {
		path: { type: 'string', required: true, description: 'Directory path (absolute or relative, "." for root)' },
	},
	async invoke(params, services, token) {
		const dirPath = params['path'] as string;
		if (!dirPath) { throw new Error('path parameter is required'); }
		const resolved = services.resolvePath(dirPath);
		const stat = await services.fileService.resolve(URI.file(resolved));
		if (!stat.children) { return `${dirPath} is not a directory or is empty`; }
		return stat.children
			.map(child => `${child.isDirectory ? '[DIR]' : '[FILE]'} ${child.name}`)
			.join('\n');
	},
};

export default listDirectory;
