/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { basename } from '../../../../../base/common/resources.js';

export const IWorkspaceFileIndexService = createDecorator<IWorkspaceFileIndexService>('workspaceFileIndexService');

export interface IWorkspaceFileIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * Initialize the service. Loads from cache or performs a full scan.
	 */
	initialize(): Promise<void>;

	/**
	 * Look up URIs by file name. O(1) hash map lookup.
	 * @param fileName File name with extension (e.g. "knowledge_chat.py")
	 * @returns Matching URI array. Empty array if none found.
	 */
	lookup(fileName: string): URI[];

	/**
	 * Resolve a relative path to a single URI via suffix matching.
	 * @param relativePath Relative path (e.g. "backend/routers/knowledge_chat.py")
	 * @returns Matching URI, or undefined if none or ambiguous.
	 */
	resolve(relativePath: string): URI | undefined;

	/**
	 * Whether the index is ready for queries.
	 */
	readonly isReady: boolean;
}

const STORAGE_KEY = 'intellicen.workspaceFileIndex';
const INDEX_VERSION = 1;

interface ISerializedFileIndex {
	version: number;
	timestamp: number;
	entries: { [fileName: string]: string[] };
}

export class WorkspaceFileIndexService extends Disposable implements IWorkspaceFileIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly _fileMap = new Map<string, URI[]>();
	private _isReady = false;

	get isReady(): boolean {
		return this._isReady;
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerFileWatcher();
	}

	async initialize(): Promise<void> {
		const loaded = this._loadFromStorage();

		if (loaded) {
			this._isReady = true;
			this.logService.info(
				`[WorkspaceFileIndex] Loaded ${this._fileMap.size} file names from cache`
			);
			this._refreshInBackground();
		} else {
			await this._fullScan();
			this._isReady = true;
			this._saveToStorage();
			this.logService.info(
				`[WorkspaceFileIndex] Full scan completed: ${this._fileMap.size} file names`
			);
		}
	}

	lookup(fileName: string): URI[] {
		return this._fileMap.get(fileName.toLowerCase()) ?? [];
	}

	resolve(relativePath: string): URI | undefined {
		const parts = relativePath.replace(/\\/g, '/').split('/');
		const fileName = parts[parts.length - 1];

		const candidates = this.lookup(fileName);
		if (candidates.length === 0) {
			return undefined;
		}
		if (candidates.length === 1) {
			return candidates[0];
		}

		// Multiple candidates — try suffix matching with relative path
		const normalizedRelative = relativePath.replace(/\\/g, '/');
		for (const uri of candidates) {
			if (uri.path.replace(/\\/g, '/').endsWith(normalizedRelative)) {
				return uri;
			}
		}

		// If suffix matching didn't narrow it down, return the first candidate
		// so the file path is still clickable (user can navigate from there)
		return candidates[0];
	}

	// ─── Cache storage ──────────────────────────────────────────

	private _loadFromStorage(): boolean {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return false;
		}

		try {
			const data: ISerializedFileIndex = JSON.parse(raw);
			if (data.version !== INDEX_VERSION) {
				return false;
			}

			this._fileMap.clear();
			for (const [fileName, uriStrings] of Object.entries(data.entries)) {
				this._fileMap.set(fileName, uriStrings.map(s => URI.parse(s)));
			}
			return true;
		} catch {
			return false;
		}
	}

	private _saveToStorage(): void {
		const entries: { [fileName: string]: string[] } = {};
		for (const [fileName, uris] of this._fileMap) {
			entries[fileName] = uris.map(u => u.toString());
		}

		const data: ISerializedFileIndex = {
			version: INDEX_VERSION,
			timestamp: Date.now(),
			entries,
		};

		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify(data),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	// ─── File scanning ──────────────────────────────────────────

	private async _fullScan(): Promise<void> {
		this._fileMap.clear();
		const folders = this.workspaceService.getWorkspace().folders;

		for (const folder of folders) {
			const result = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries: [{ folder: folder.uri }],
				maxResults: 100_000,
			});

			for (const match of result.results) {
				this._addToMap(match.resource);
			}
		}
	}

	private async _refreshInBackground(): Promise<void> {
		try {
			const freshMap = new Map<string, URI[]>();
			const folders = this.workspaceService.getWorkspace().folders;

			for (const folder of folders) {
				const result = await this.searchService.fileSearch({
					type: QueryType.File,
					folderQueries: [{ folder: folder.uri }],
					maxResults: 100_000,
				});
				for (const match of result.results) {
					const name = basename(match.resource).toLowerCase();
					const existing = freshMap.get(name) ?? [];
					existing.push(match.resource);
					freshMap.set(name, existing);
				}
			}

			this._fileMap.clear();
			for (const [k, v] of freshMap) {
				this._fileMap.set(k, v);
			}
			this._saveToStorage();
		} catch (err) {
			this.logService.warn('[WorkspaceFileIndex] Background refresh failed', err);
		}
	}

	// ─── Real-time file change watching ─────────────────────────

	private _registerFileWatcher(): void {
		this._register(this.fileService.onDidFilesChange(e => {
			let changed = false;

			for (const resource of e.rawAdded) {
				this._addToMap(resource);
				changed = true;
			}

			for (const resource of e.rawDeleted) {
				this._removeFromMap(resource);
				changed = true;
			}

			if (changed) {
				this._saveToStorage();
			}
		}));
	}

	private _addToMap(uri: URI): void {
		const name = basename(uri).toLowerCase();
		const existing = this._fileMap.get(name) ?? [];
		if (!existing.some(u => u.toString() === uri.toString())) {
			existing.push(uri);
			this._fileMap.set(name, existing);
		}
	}

	private _removeFromMap(uri: URI): void {
		const name = basename(uri).toLowerCase();
		const existing = this._fileMap.get(name);
		if (!existing) {
			return;
		}

		const uriString = uri.toString();
		const filtered = existing.filter(u => u.toString() !== uriString);
		if (filtered.length === 0) {
			this._fileMap.delete(name);
		} else {
			this._fileMap.set(name, filtered);
		}
	}
}
