/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { IIntelliCenToolDefinition } from './framework.js';

const readFile: IIntelliCenToolDefinition = {
	id: 'intellicen_readFile',
	name: 'Read File',
	description: 'Read the contents of a file. Accepts absolute or workspace-relative paths.',
	toolSet: 'read',
	referenceName: 'readFile',
	parameters: {
		path: { type: 'string', required: true, description: 'File path (absolute or relative to workspace root)' },
	},
	async invoke(params, services, token) {
		const filePath = params['path'] as string;
		if (!filePath) { throw new Error('path parameter is required'); }
		const resolved = services.resolvePath(filePath);
		const content = await services.fileService.readFile(URI.file(resolved), undefined, token);
		return content.value.toString();
	},
};

export default readFile;
