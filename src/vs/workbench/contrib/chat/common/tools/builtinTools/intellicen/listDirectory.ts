/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { IIntelliCenToolDefinition } from './framework.js';

/** Maximum number of entries returned per listDirectory call. */
const MAX_ENTRIES = 200;

/**
 * Directories that are almost never relevant to code exploration and add noise.
 * These are filtered out by default unless the path explicitly targets them.
 */
const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'out', 'build', '.cache',
	'coverage', '.nyc_output', '__pycache__', '.pytest_cache',
]);

const listDirectory: IIntelliCenToolDefinition = {
	id: 'intellicen_listDirectory',
	name: 'List Directory',
	description: [
		'List files and subdirectories at a given path. Use "." for workspace root.',
		'Returns entries prefixed with [FILE] or [DIR].',
		`At most ${MAX_ENTRIES} entries are returned. Common noise directories (node_modules, .git, dist, out, build)`,
		'are skipped automatically. If entries are truncated, a count is shown.',
	].join(' '),
	toolSet: 'read',
	referenceName: 'ls',
	parameters: {
		path: { type: 'string', required: true, description: 'Directory path (absolute or relative, "." for root)' },
	},
	async invoke(params, services, _token) {
		const dirPath = params['path'] as string;
		if (!dirPath) { throw new Error('path parameter is required'); }
		const resolved = services.resolvePath(dirPath);
		const stat = await services.fileService.resolve(URI.file(resolved));
		if (!stat.children) { return `${dirPath} is not a directory or is empty`; }

		const all = stat.children;
		const filtered = all.filter(child => !IGNORED_DIRS.has(child.name));

		// Directories first, then files, both alphabetically
		filtered.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
			return a.name.localeCompare(b.name);
		});

		const shown = filtered.slice(0, MAX_ENTRIES);
		const lines = shown.map(child => `${child.isDirectory ? '[DIR]' : '[FILE]'} ${child.name}`);

		const skipped = all.length - filtered.length;
		const truncated = filtered.length - shown.length;

		if (skipped > 0) {
			lines.push(`[${skipped} noise director${skipped === 1 ? 'y' : 'ies'} hidden (node_modules etc.)]`);
		}
		if (truncated > 0) {
			lines.push(`[${truncated} more entries not shown — narrow the path for a more specific listing]`);
		}

		return lines.join('\n');
	},
};

export default listDirectory;
