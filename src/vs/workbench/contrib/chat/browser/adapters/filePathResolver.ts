/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWorkspaceFileIndexService } from './workspaceFileIndexService.js';

export const IFilePathResolver = createDecorator<IFilePathResolver>('filePathResolver');

export interface IFilePathResolverMatch {
	/** Start position in the original text */
	start: number;
	/** End position in the original text */
	end: number;
	/** Matched text (e.g. "backend/routers/knowledge_chat.py") */
	text: string;
	/** Resolved workspace file URI */
	uri: URI;
	/** Display name (e.g. "knowledge_chat.py") */
	displayName: string;
}

export interface IFilePathResolver {
	readonly _serviceBrand: undefined;

	/**
	 * Detect file paths in text and match them against workspace files.
	 * @param text LLM response text
	 * @returns Matched file paths sorted by position
	 */
	detectFilePaths(text: string): IFilePathResolverMatch[];
}

/**
 * File extensions to recognize as file path patterns.
 */
const FILE_EXTENSIONS = [
	// Web/frontend
	'ts', 'tsx', 'js', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html',
	// Backend
	'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'swift', 'cs',
	// Config/data
	'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'graphql',
	// Docs
	'md', 'mdx', 'txt', 'rst',
	// Shell/infra
	'sh', 'bash', 'zsh', 'dockerfile', 'tf',
	// Other
	'cpp', 'cc', 'c', 'h', 'hpp',
];

const LONG_EXTENSIONS = FILE_EXTENSIONS.filter(e => e.length >= 2);
const SHORT_EXTENSIONS = FILE_EXTENSIONS.filter(e => e.length === 1);

function buildFilePathRegex(): RegExp {
	const extGroup = LONG_EXTENSIONS.join('|');
	return new RegExp(
		`(?<![\\w/\\\\])` +
		`(?:(?:[\\w.\\-]+/)+)?` +
		`[\\w.\\-]+` +
		`\\.(?:${extGroup})` +
		`(?![\\w./])`,
		'gi'
	);
}

function buildShortExtFilePathRegex(): RegExp {
	if (SHORT_EXTENSIONS.length === 0) {
		return /(?!)/;
	}
	const extGroup = SHORT_EXTENSIONS.join('|');
	return new RegExp(
		`(?<![\\w/\\\\])` +
		`(?:[\\w.\\-]+/)+` +
		`[\\w.\\-]+` +
		`\\.(?:${extGroup})` +
		`(?![\\w./])`,
		'gi'
	);
}

const FILE_PATH_RE = buildFilePathRegex();
const SHORT_EXT_FILE_PATH_RE = buildShortExtFilePathRegex();

/**
 * Detect code block and inline code ranges to exclude from matching.
 */
function getCodeRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];

	const fencedRe = /```[\s\S]*?```/g;
	let match: RegExpExecArray | null;
	while ((match = fencedRe.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}

	const inlineRe = /`[^`\n]+`/g;
	while ((match = inlineRe.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}

	return ranges;
}

/**
 * Check if a match position is inside a URL.
 */
function isInsideUrl(text: string, matchStart: number): boolean {
	const before = text.substring(Math.max(0, matchStart - 100), matchStart);
	return /https?:\/\/[^\s]*$/.test(before);
}

/**
 * Check if a file name is purely numeric (to avoid false positives like version numbers).
 */
function isNumericFileName(match: string): boolean {
	const parts = match.split('/');
	const fileName = parts[parts.length - 1];
	const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
	return /^[\d.]+$/.test(nameWithoutExt);
}

export class FilePathResolver implements IFilePathResolver {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IWorkspaceFileIndexService private readonly fileIndex: IWorkspaceFileIndexService,
	) { }

	detectFilePaths(text: string): IFilePathResolverMatch[] {
		if (!this.fileIndex.isReady) {
			return [];
		}

		const codeRanges = getCodeRanges(text);
		const results: IFilePathResolverMatch[] = [];

		const processRegex = (regex: RegExp) => {
			regex.lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = regex.exec(text)) !== null) {
				const matchText = match[0];
				const matchStart = match.index;
				const matchEnd = matchStart + matchText.length;

				// Skip matches inside code blocks
				if (codeRanges.some(r => matchStart >= r.start && matchEnd <= r.end)) {
					continue;
				}

				// Skip matches inside URLs
				if (isInsideUrl(text, matchStart)) {
					continue;
				}

				// Skip numeric file names (e.g. v1.2.3)
				if (isNumericFileName(matchText)) {
					continue;
				}

				// Match against workspace files
				const uri = this.fileIndex.resolve(matchText);
				if (!uri) {
					continue;
				}

				const parts = matchText.replace(/\\/g, '/').split('/');
				const displayName = parts[parts.length - 1];

				results.push({
					start: matchStart,
					end: matchEnd,
					text: matchText,
					uri,
					displayName,
				});
			}
		};

		processRegex(FILE_PATH_RE);
		processRegex(SHORT_EXT_FILE_PATH_RE);

		// Sort by position, remove overlaps
		results.sort((a, b) => a.start - b.start);
		return results.filter((r, i) =>
			i === 0 || r.start >= results[i - 1].end
		);
	}
}
