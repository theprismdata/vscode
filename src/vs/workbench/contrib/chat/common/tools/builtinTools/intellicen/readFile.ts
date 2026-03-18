/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { IIntelliCenToolDefinition } from './framework.js';

/** Maximum characters returned per readFile call to avoid overflowing the model context window. */
const MAX_CHARS = 12_000;

const readFile: IIntelliCenToolDefinition = {
	id: 'intellicen_readFile',
	name: 'Read File',
	description: [
		'Read the contents of a file. Accepts absolute or workspace-relative paths.',
		'Supports pagination via optional `offset` (line number, 1-based) and `limit` (number of lines) parameters.',
		`At most ${MAX_CHARS} characters are returned per call. If the output is truncated, a "[TRUNCATED]" marker`,
		'and the total line count are appended so you can paginate with another call.',
	].join(' '),
	toolSet: 'read',
	referenceName: 'readFile',
	parameters: {
		path: { type: 'string', required: true, description: 'File path (absolute or relative to workspace root)' },
		offset: { type: 'number', required: false, description: 'First line to return (1-based). Defaults to 1.' },
		limit: { type: 'number', required: false, description: 'Maximum number of lines to return. Defaults to 200.' },
	},
	async invoke(params, services, token) {
		const filePath = params['path'] as string;
		if (!filePath) { throw new Error('path parameter is required'); }

		const offset = Math.max(1, Number(params['offset'] ?? 1));
		const limit = Math.min(500, Math.max(1, Number(params['limit'] ?? 200)));

		const resolved = services.resolvePath(filePath);
		const content = await services.fileService.readFile(URI.file(resolved), undefined, token);
		const allLines = content.value.toString().split('\n');
		const totalLines = allLines.length;

		const startIdx = offset - 1; // convert to 0-based
		const slice = allLines.slice(startIdx, startIdx + limit);
		let result = slice.join('\n');

		// Hard cap on characters
		if (result.length > MAX_CHARS) {
			result = result.slice(0, MAX_CHARS);
			result += `\n[TRUNCATED — exceeded ${MAX_CHARS} chars. Total lines: ${totalLines}. Use offset/limit to paginate.]`;
		} else if (startIdx + limit < totalLines) {
			result += `\n[Showing lines ${offset}–${offset + slice.length - 1} of ${totalLines}. Use offset=${offset + slice.length} to read more.]`;
		}

		return result;
	},
};

export default readFile;
