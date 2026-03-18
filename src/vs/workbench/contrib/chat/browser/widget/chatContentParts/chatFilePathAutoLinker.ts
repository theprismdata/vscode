/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IFilePathResolver, IFilePathResolverMatch } from '../../adapters/filePathResolver.js';
import { IChatMarkdownAnchorService } from './chatMarkdownAnchorService.js';
import { renderFileWidgets } from './chatInlineAnchorWidget.js';

/**
 * Walks the rendered markdown DOM, detects file paths in text nodes,
 * and converts them to clickable `<a>` links that `renderFileWidgets()`
 * can then turn into InlineAnchorWidgets.
 */
export function autoLinkFilePaths(
	element: HTMLElement,
	filePathResolver: IFilePathResolver,
	instantiationService: IInstantiationService,
	chatMarkdownAnchorService: IChatMarkdownAnchorService,
	disposables: DisposableStore,
): void {
	// Collect text nodes (avoid modifying the tree while iterating)
	const textNodes: Text[] = [];
	const codeElementNodes: HTMLElement[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent) {
				return NodeFilter.FILTER_ACCEPT;
			}
			// Skip text inside <pre> (fenced code blocks) and <a> elements
			if (parent.tagName === 'PRE' || parent.tagName === 'A') {
				return NodeFilter.FILTER_REJECT;
			}
			// Skip text inside <pre><code> (fenced code blocks)
			if (parent.tagName === 'CODE' && parent.parentElement?.tagName === 'PRE') {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		}
	});

	// Also collect inline <code> elements whose text content looks like a file path
	const codeWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, {
		acceptNode(node) {
			const el = node as HTMLElement;
			if (el.tagName === 'CODE' && el.parentElement?.tagName !== 'PRE') {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		}
	});
	let codeNode: Node | null;
	while ((codeNode = codeWalker.nextNode())) {
		codeElementNodes.push(codeNode as HTMLElement);
	}

	let current: Node | null;
	while ((current = walker.nextNode())) {
		textNodes.push(current as Text);
	}

	let anyLinked = false;

	for (const textNode of textNodes) {
		const text = textNode.textContent;
		if (!text) {
			continue;
		}

		const matches = filePathResolver.detectFilePaths(text);
		if (matches.length === 0) {
			continue;
		}

		// Build replacement fragment
		const fragment = document.createDocumentFragment();
		let lastIndex = 0;

		for (const match of matches) {
			// Text before the match
			if (match.start > lastIndex) {
				fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.start)));
			}

			// Create an <a> element with data-href pointing to the file URI
			const anchor = createFileAnchor(match);
			fragment.appendChild(anchor);

			lastIndex = match.end;
		}

		// Remaining text after last match
		if (lastIndex < text.length) {
			fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
		}

		// Replace the text node with the fragment
		textNode.parentNode?.replaceChild(fragment, textNode);
		anyLinked = true;
	}

	// Handle inline <code> elements: if the entire content is a file path,
	// replace the <code> element with a clickable anchor.
	for (const codeEl of codeElementNodes) {
		const text = codeEl.textContent;
		if (!text) {
			continue;
		}

		const matches = filePathResolver.detectFilePaths(text);
		// Only convert if the entire <code> content is a single file path
		if (matches.length === 1 && matches[0].start === 0 && matches[0].end === text.length) {
			const anchor = createFileAnchor(matches[0]);
			codeEl.parentNode?.replaceChild(anchor, codeEl);
			anyLinked = true;
		}
	}

	// Let renderFileWidgets turn the <a> elements into InlineAnchorWidgets
	if (anyLinked) {
		renderFileWidgets(element, instantiationService, chatMarkdownAnchorService, disposables);
	}
}

function createFileAnchor(match: IFilePathResolverMatch): HTMLAnchorElement {
	const anchor = document.createElement('a');
	const uri = match.uri.with({ query: 'vscodeLinkType=file' });
	anchor.setAttribute('data-href', uri.toString());
	anchor.textContent = match.text;
	anchor.title = match.uri.fsPath;
	return anchor;
}
