/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIntelliCenToolDefinition } from './framework.js';

const searchFiles: IIntelliCenToolDefinition = {
	id: 'intellicen_searchFiles',
	name: 'Search Files',
	description: 'Search for a text pattern across files using grep. Returns matching lines with file paths and line numbers.',
	toolSet: 'read',
	referenceName: 'grep',
	parameters: {
		pattern: { type: 'string', required: true, description: 'Search pattern (regex supported)' },
		path: { type: 'string', description: 'Directory to search (default: workspace root)' },
		include: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
	},
	async invoke(params, services) {
		const pattern = params['pattern'] as string;
		if (!pattern) { throw new Error('pattern parameter is required'); }
		const searchPath = services.resolvePath((params['path'] as string) || '.');
		const include = params['include'] as string;
		let cmd = `grep -rn "${pattern}" "${searchPath}"`;
		if (include) {
			cmd += ` --include="${include}"`;
		}
		cmd += ' | head -50';
		const result = await services.shellExecService.exec(cmd);
		return result.stdout || '(no matches found)';
	},
};

export default searchFiles;
