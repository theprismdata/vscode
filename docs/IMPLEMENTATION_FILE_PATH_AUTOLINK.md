# 채팅 응답 파일 경로 자동 링크 구현 가이드

## 1. 개요

### 문제
IntelliCen Studio의 채팅 패널에서 LLM 응답에 포함된 파일 경로(예: `knowledge_chat.py`, `backend/routers/chat.py`)가 일반 텍스트로 렌더링되어 클릭해도 파일이 열리지 않음.

### 목표
LLM 응답 내의 파일 경로를 자동 감지하여, 워크스페이스 내 실제 파일과 매칭되면 클릭 가능한 `InlineAnchorWidget`(파일 pill)으로 변환한다.

### 설계 원칙
- Copilot의 기존 `inlineReference` → `annotateSpecialMarkdownContent()` → `InlineAnchorWidget` 파이프라인을 **그대로 재활용**
- 렌더러 코드 수정 없음
- 워크스페이스 파일 인덱스를 영구 캐시하여 성능 보장

---

## 2. 아키텍처 개요

```
┌──────────────────────────────────────────────────────────────┐
│                      전체 데이터 흐름                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  LLM API 응답 (Anthropic/OpenAI/vLLM)                        │
│    └→ Adapter (anthropicAdapter.ts 등)                        │
│        └→ IChatResponsePart[] { type: 'text', value: '...' } │
│            └→ ★ FilePathResolver (새로 추가) ★                │
│                └→ 텍스트에서 파일 경로 패턴 감지                 │
│                └→ WorkspaceFileIndexService로 실제 파일 매칭    │
│                └→ text + inlineReference 파트로 분할            │
│                    └→ chatModel.ts → IChatProgressResponseContent[]  │
│                        └→ annotations.ts: annotateSpecialMarkdownContent()  │
│                            └→ [file.py](http://_vscodecontentref_/0)  │
│                                └→ InlineAnchorWidget (클릭 가능!)  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │          WorkspaceFileIndexService                   │     │
│  │  ┌───────────┐  ┌──────────┐  ┌──────────────────┐ │     │
│  │  │ 인메모리   │  │ 영구저장  │  │ 실시간 갱신       │ │     │
│  │  │ Map<name,  │←→│ IStorage │←─│ onDidFilesChange │ │     │
│  │  │   URI[]>   │  │ Service  │  │                  │ │     │
│  │  └───────────┘  └──────────┘  └──────────────────┘ │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 신규 파일 목록

| # | 파일 경로 | 역할 |
|---|----------|------|
| 1 | `src/vs/workbench/contrib/chat/browser/adapters/workspaceFileIndexService.ts` | 워크스페이스 파일 인덱스 + 영구 캐시 |
| 2 | `src/vs/workbench/contrib/chat/browser/adapters/filePathResolver.ts` | 텍스트에서 파일 경로 감지 + inlineReference 변환 |

---

## 4. 수정 파일 목록

| # | 파일 경로 | 수정 내용 |
|---|----------|----------|
| 1 | `src/vs/workbench/contrib/chat/common/languageModels.ts` | `IChatResponsePart`에 `inlineReference` 타입 추가 |
| 2 | `src/vs/workbench/contrib/chat/browser/adapters/anthropicAdapter.ts` | 응답 후처리에 FilePathResolver 호출 |
| 3 | `src/vs/workbench/contrib/chat/browser/adapters/openAIAdapter.ts` | (동일) 응답 후처리에 FilePathResolver 호출 |
| 4 | `src/vs/workbench/contrib/chat/browser/customLanguageModelProviderContribution.ts` | FilePathResolver, WorkspaceFileIndexService DI 등록 |

---

## 5. 상세 구현

### 5.1 WorkspaceFileIndexService

**파일**: `src/vs/workbench/contrib/chat/browser/adapters/workspaceFileIndexService.ts`

#### 5.1.1 역할
- 워크스페이스 내 모든 파일의 `fileName → URI[]` 매핑을 인메모리 Map으로 관리
- `IStorageService`를 이용해 영구 캐시 (VS Code 재시작 후에도 유지)
- `IFileService.onDidFilesChange` 이벤트로 실시간 동기화

#### 5.1.2 인터페이스

```typescript
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';

export const IWorkspaceFileIndexService = createDecorator<IWorkspaceFileIndexService>('workspaceFileIndexService');

export interface IWorkspaceFileIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * 서비스 초기화. 캐시 로드 또는 전체 스캔 수행.
	 */
	initialize(): Promise<void>;

	/**
	 * 파일명으로 URI 목록 조회. O(1) 해시맵 조회.
	 * @param fileName 확장자 포함 파일명 (예: "knowledge_chat.py")
	 * @returns 매칭되는 URI 배열. 없으면 빈 배열.
	 */
	lookup(fileName: string): URI[];

	/**
	 * 상대 경로로 URI 조회. 파일명 lookup 후 경로 접미사 매칭.
	 * @param relativePath 상대 경로 (예: "backend/routers/knowledge_chat.py")
	 * @returns 매칭되는 URI. 없거나 여러 개면 undefined.
	 */
	resolve(relativePath: string): URI | undefined;

	/**
	 * 인덱스가 준비되었는지 여부.
	 */
	readonly isReady: boolean;
}
```

#### 5.1.3 구현 클래스

```typescript
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService, FileChangeType } from '../../../../../platform/files/common/files.js';
import { ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';

const STORAGE_KEY = 'intellicen.workspaceFileIndex';
const INDEX_VERSION = 1;

interface ISerializedFileIndex {
	version: number;
	timestamp: number;
	entries: { [fileName: string]: string[] }; // fileName → URI string[]
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
		// 1단계: 캐시에서 로드 시도
		const loaded = this._loadFromStorage();

		if (loaded) {
			this._isReady = true;
			this.logService.info(
				`[WorkspaceFileIndex] Loaded ${this._fileMap.size} file names from cache`
			);
			// 백그라운드에서 증분 갱신
			this._refreshInBackground();
		} else {
			// 2단계: 전체 스캔
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
		// 파일명 추출
		const parts = relativePath.replace(/\\/g, '/').split('/');
		const fileName = parts[parts.length - 1];

		const candidates = this.lookup(fileName);
		if (candidates.length === 0) {
			return undefined;
		}
		if (candidates.length === 1) {
			return candidates[0];
		}

		// 여러 개면 상대 경로 접미사 매칭
		const normalizedRelative = relativePath.replace(/\\/g, '/');
		for (const uri of candidates) {
			if (uri.path.replace(/\\/g, '/').endsWith(normalizedRelative)) {
				return uri;
			}
		}

		return undefined; // 매칭 불가 → 링크 안 걸기
	}

	// ─── 캐시 저장/로드 ─────────────────────────────────────

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

	// ─── 파일 스캔 ──────────────────────────────────────────

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
		// 간단한 방식: 전체 스캔 후 diff → 업데이트
		// 향후 최적화: 타임스탬프 기반 증분 스캔
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

	// ─── 실시간 파일 변경 감시 ──────────────────────────────

	private _registerFileWatcher(): void {
		this._register(this.fileService.onDidFilesChange(e => {
			let changed = false;

			// 추가된 파일
			for (const added of e.getAdded()) {
				this._addToMap(added.resource);
				changed = true;
			}

			// 삭제된 파일
			for (const deleted of e.getDeleted()) {
				this._removeFromMap(deleted.resource);
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
		// 중복 방지
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
```

#### 5.1.4 스토리지 데이터 구조

```json
{
  "version": 1,
  "timestamp": 1710720000000,
  "entries": {
    "knowledge_chat.py": ["file:///Users/prismdata/project/backend/routers/knowledge_chat.py"],
    "chat.py": [
      "file:///Users/prismdata/project/backend/routers/chat.py",
      "file:///Users/prismdata/project/tests/chat.py"
    ],
    "index.ts": [
      "file:///Users/prismdata/project/src/index.ts",
      "file:///Users/prismdata/project/src/utils/index.ts"
    ]
  }
}
```

---

### 5.2 FilePathResolver

**파일**: `src/vs/workbench/contrib/chat/browser/adapters/filePathResolver.ts`

#### 5.2.1 역할
- LLM 응답 텍스트에서 파일 경로 패턴을 정규식으로 감지
- `WorkspaceFileIndexService`로 실제 파일 매칭
- 텍스트를 `IChatResponsePart[]` (text + inlineReference 혼합)로 분할

#### 5.2.2 인터페이스

```typescript
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';

export const IFilePathResolver = createDecorator<IFilePathResolver>('filePathResolver');

export interface IFilePathResolverMatch {
	/** 원본 텍스트에서의 시작 위치 */
	start: number;
	/** 원본 텍스트에서의 끝 위치 */
	end: number;
	/** 매칭된 텍스트 (예: "backend/routers/knowledge_chat.py") */
	text: string;
	/** 확인된 워크스페이스 파일 URI */
	uri: URI;
	/** 표시 이름 (예: "knowledge_chat.py") */
	displayName: string;
}

export interface IFilePathResolver {
	readonly _serviceBrand: undefined;

	/**
	 * 텍스트에서 파일 경로를 감지하고 워크스페이스 파일과 매칭한다.
	 * @param text LLM 응답 텍스트
	 * @returns 매칭된 파일 경로 목록 (위치순 정렬)
	 */
	detectFilePaths(text: string): IFilePathResolverMatch[];
}
```

#### 5.2.3 구현 클래스

```typescript
import { IWorkspaceFileIndexService } from './workspaceFileIndexService.js';
import { URI } from '../../../../../base/common/uri.js';

/**
 * 파일 경로로 인식할 확장자 목록.
 * 너무 짧은 확장자(예: .c, .h)는 오탐 가능성이 높으므로
 * 경로 구분자가 포함된 경우에만 매칭.
 */
const FILE_EXTENSIONS = [
	// 웹/프론트엔드
	'ts', 'tsx', 'js', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html',
	// 백엔드
	'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'swift', 'cs',
	// 설정/데이터
	'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'graphql',
	// 문서
	'md', 'mdx', 'txt', 'rst',
	// 쉘/인프라
	'sh', 'bash', 'zsh', 'dockerfile', 'tf',
	// 기타
	'cpp', 'cc', 'c', 'h', 'hpp',
];

const LONG_EXTENSIONS = FILE_EXTENSIONS.filter(e => e.length >= 2);
const SHORT_EXTENSIONS = FILE_EXTENSIONS.filter(e => e.length === 1); // c, h

/**
 * 파일 경로 감지 정규식.
 *
 * 매칭 대상:
 * - `knowledge_chat.py` (파일명 + 확장자)
 * - `backend/routers/knowledge_chat.py` (상대 경로)
 * - `src/utils/index.ts` (슬래시 경로)
 *
 * 제외 대상:
 * - URL 내부 경로 (http://, https://)
 * - 코드블록 내부 (별도 처리)
 * - 버전 번호 (v1.2.3)
 * - 소수점 숫자 (3.14)
 */
function buildFilePathRegex(): RegExp {
	const extGroup = LONG_EXTENSIONS.join('|');
	// 파일명: word chars, dots, hyphens + 확장자
	// 선택적 경로 접두사: (dir/)* 형태
	// 경계: 앞에 알파벳/슬래시/백슬래시가 아닌 문자 (또는 문자열 시작)
	return new RegExp(
		`(?<![\\w/\\\\])` +                           // 앞 경계 (URL 경로 중간 방지)
		`(?:(?:[\\w.\\-]+/)+)?` +                     // 선택적 디렉토리 경로
		`[\\w.\\-]+` +                                // 파일명
		`\\.(?:${extGroup})` +                        // .확장자
		`(?![\\w./])`,                                // 뒤 경계
		'gi'
	);
}

/**
 * 단일 문자 확장자(.c, .h)는 경로 구분자가 있을 때만 매칭.
 */
function buildShortExtFilePathRegex(): RegExp {
	if (SHORT_EXTENSIONS.length === 0) {
		return /(?!)/; // never matches
	}
	const extGroup = SHORT_EXTENSIONS.join('|');
	return new RegExp(
		`(?<![\\w/\\\\])` +
		`(?:[\\w.\\-]+/)+` +                          // 반드시 경로 포함
		`[\\w.\\-]+` +
		`\\.(?:${extGroup})` +
		`(?![\\w./])`,
		'gi'
	);
}

const FILE_PATH_RE = buildFilePathRegex();
const SHORT_EXT_FILE_PATH_RE = buildShortExtFilePathRegex();

/**
 * 코드블록/인라인코드 영역을 감지하여 제외할 범위를 반환.
 */
function getCodeRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];

	// 펜스드 코드블록 (```)
	const fencedRe = /```[\s\S]*?```/g;
	let match: RegExpExecArray | null;
	while ((match = fencedRe.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}

	// 인라인 코드 (`)
	const inlineRe = /`[^`\n]+`/g;
	while ((match = inlineRe.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}

	return ranges;
}

/**
 * URL 내부인지 확인.
 */
function isInsideUrl(text: string, matchStart: number): boolean {
	// 매칭 위치 앞쪽에서 http:// 또는 https:// 패턴을 찾음
	const before = text.substring(Math.max(0, matchStart - 100), matchStart);
	return /https?:\/\/[^\s]*$/.test(before);
}

/**
 * 숫자로만 된 파일명인지 (버전번호 오탐 방지).
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
	) {}

	detectFilePaths(text: string): IFilePathResolverMatch[] {
		if (!this.fileIndex.isReady) {
			return [];
		}

		const codeRanges = getCodeRanges(text);
		const results: IFilePathResolverMatch[] = [];

		const processRegex = (regex: RegExp) => {
			regex.lastIndex = 0; // reset
			let match: RegExpExecArray | null;

			while ((match = regex.exec(text)) !== null) {
				const matchText = match[0];
				const matchStart = match.index;
				const matchEnd = matchStart + matchText.length;

				// 코드블록 내부 제외
				if (codeRanges.some(r => matchStart >= r.start && matchEnd <= r.end)) {
					continue;
				}

				// URL 내부 제외
				if (isInsideUrl(text, matchStart)) {
					continue;
				}

				// 숫자 파일명 제외 (v1.2.3 등)
				if (isNumericFileName(matchText)) {
					continue;
				}

				// 워크스페이스에서 파일 매칭
				const uri = this.fileIndex.resolve(matchText);
				if (!uri) {
					continue;
				}

				// 표시 이름 (파일명만)
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

		// 위치순 정렬, 중복 제거
		results.sort((a, b) => a.start - b.start);
		return results.filter((r, i) =>
			i === 0 || r.start >= results[i - 1].end
		);
	}
}
```

---

### 5.3 IChatResponsePart 타입 확장

**파일**: `src/vs/workbench/contrib/chat/common/languageModels.ts`

#### 변경 내용

```typescript
// ── 기존 ──
export type IChatResponsePart =
	| IChatResponseTextPart
	| IChatResponseToolUsePart
	| IChatResponseDataPart
	| IChatResponseThinkingPart;

// ── 변경 후 ──
export interface IChatResponseInlineReferencePart {
	type: 'inlineReference';
	uri: URI;
	name: string;
}

export type IChatResponsePart =
	| IChatResponseTextPart
	| IChatResponseToolUsePart
	| IChatResponseDataPart
	| IChatResponseThinkingPart
	| IChatResponseInlineReferencePart;  // 추가
```

### 5.4 응답 파트 → IChatProgressResponseContent 변환

`IChatResponsePart`의 `inlineReference`가 `IChatProgressResponseContent`의 `IChatContentInlineReference`로 변환되어야 한다.

**확인할 파일**: 어댑터에서 `IChatResponsePart[]`를 생성한 뒤, 이를 소비하는 곳에서 `inlineReference` 타입을 `IChatContentInlineReference`(`kind: 'inlineReference'`)로 매핑하는 로직 추가.

응답 스트림을 소비하는 곳(예: `chatServiceImpl.ts` 또는 커스텀 LM 프로바이더의 스트림 처리)에서:

```typescript
for (const part of parts) {
	if (part.type === 'text') {
		// 기존 markdownContent 처리
	} else if (part.type === 'inlineReference') {
		// → IChatContentInlineReference로 변환
		progress.report({
			kind: 'inlineReference',
			inlineReference: part.uri,
			name: part.name,
		});
	}
}
```

이렇게 하면 `annotateSpecialMarkdownContent()`가 자동으로 `[file.py](http://_vscodecontentref_/N)` 링크를 생성하고, `InlineAnchorWidget`으로 렌더링된다.

---

### 5.5 Anthropic 어댑터 수정

**파일**: `src/vs/workbench/contrib/chat/browser/adapters/anthropicAdapter.ts`

#### 변경 위치: `sendAnthropicChatRequest()` 함수 (219-236줄)

```typescript
// ── 기존 ──
const parts: IChatResponsePart[] = [];

for (const block of parsed.content ?? []) {
	if (block.type === 'text') {
		parts.push({ type: 'text', value: block.text });
	} else if (block.type === 'tool_use') {
		parts.push({ ... });
	}
}

// ── 변경 후 ──
const parts: IChatResponsePart[] = [];

for (const block of parsed.content ?? []) {
	if (block.type === 'text') {
		// 파일 경로 감지 및 분할
		const resolved = filePathResolver.detectFilePaths(block.text);

		if (resolved.length === 0) {
			// 매칭 없음 → 기존과 동일
			parts.push({ type: 'text', value: block.text });
		} else {
			// 텍스트를 text + inlineReference로 분할
			let cursor = 0;
			for (const match of resolved) {
				// 매칭 이전 텍스트
				if (match.start > cursor) {
					parts.push({ type: 'text', value: block.text.substring(cursor, match.start) });
				}
				// inlineReference 파트
				parts.push({
					type: 'inlineReference',
					uri: match.uri,
					name: match.displayName,
				});
				cursor = match.end;
			}
			// 나머지 텍스트
			if (cursor < block.text.length) {
				parts.push({ type: 'text', value: block.text.substring(cursor) });
			}
		}
	} else if (block.type === 'tool_use') {
		parts.push({ ... });
	}
}
```

#### 함수 시그니처 변경

`filePathResolver`를 함수 파라미터로 받거나, 어댑터를 클래스로 리팩터링하여 DI로 주입.

```typescript
export async function sendAnthropicChatRequest(
	apiKey: string | undefined,
	modelId: string,
	messages: IChatMessage[],
	requestService: IRequestService,
	token: CancellationToken,
	tools?: IAnthropicTool[],
	filePathResolver?: IFilePathResolver,  // 추가 (optional로 하위호환)
): Promise<ILanguageModelChatResponse> {
	// ...
}
```

---

### 5.6 DI 등록 및 초기화

**파일**: `src/vs/workbench/contrib/chat/browser/customLanguageModelProviderContribution.ts`

```typescript
import { IWorkspaceFileIndexService, WorkspaceFileIndexService } from './adapters/workspaceFileIndexService.js';
import { IFilePathResolver, FilePathResolver } from './adapters/filePathResolver.js';

// 서비스 등록
registerSingleton(IWorkspaceFileIndexService, WorkspaceFileIndexService, InstantiationType.Delayed);
registerSingleton(IFilePathResolver, FilePathResolver, InstantiationType.Delayed);
```

초기화는 커스텀 LM 프로바이더가 활성화될 때:

```typescript
// 워크벤치 contribution의 activate()에서
const fileIndex = accessor.get(IWorkspaceFileIndexService);
await fileIndex.initialize();
```

---

## 6. 동명 파일 처리 전략

LLM이 `chat.py`라고만 언급했을 때 워크스페이스에 여러 `chat.py`가 있는 경우:

| 경우 | 처리 |
|------|------|
| 매칭 1개 | 바로 링크 |
| 매칭 2개+ & 상대 경로 있음 (`backend/routers/chat.py`) | 경로 접미사 매칭으로 1개 선택 |
| 매칭 2개+ & 파일명만 (`chat.py`) | 링크 안 걸기 (오탐 방지) |
| 매칭 0개 | 일반 텍스트 유지 |

---

## 7. 오탐 방지 규칙

| 패턴 | 예시 | 처리 |
|------|------|------|
| URL 내부 | `https://api.com/v1/chat.py` | 제외 |
| 코드블록 내부 | `` `chat.py` ``, ` ```...``` ` | 제외 |
| 버전 번호 | `v1.2.3`, `1.0.0` | 숫자 파일명 제외 |
| 도메인 | `example.com`, `google.co` | 확장자 목록에 없으므로 자동 제외 |
| 마크다운 링크 내부 | `[text](http://...)` | URL 경계 검사로 제외 |

---

## 8. 성능 고려사항

| 항목 | 설계 |
|------|------|
| 초기 로드 | 캐시 있으면 JSON parse만 (수 ms), 없으면 전체 스캔 1회 |
| 파일 조회 | Map.get() O(1), 디스크 I/O 없음 |
| 실시간 갱신 | onDidFilesChange 이벤트 기반, 폴링 없음 |
| 캐시 저장 | 변경 시 IStorageService에 flush (VS Code가 관리하는 SQLite) |
| 정규식 매칭 | 응답 텍스트 길이에 비례, 일반적으로 수 ms 이내 |
| 메모리 | 10,000개 파일 기준 약 500KB~1MB (파일명 + URI 문자열) |

---

## 9. 테스트 계획

### 9.1 WorkspaceFileIndexService 단위 테스트

```
src/vs/workbench/contrib/chat/test/browser/adapters/workspaceFileIndexService.test.ts
```

- `initialize()`: 캐시 없을 때 전체 스캔 후 Map 구축
- `initialize()`: 캐시 있을 때 로드 후 백그라운드 갱신
- `lookup()`: 파일명으로 정확한 URI 반환
- `lookup()`: 동명 파일 여러 개 반환
- `resolve()`: 상대 경로로 유일한 파일 매칭
- `resolve()`: 상대 경로 매칭 실패 시 undefined
- 파일 추가/삭제 이벤트 시 Map 업데이트

### 9.2 FilePathResolver 단위 테스트

```
src/vs/workbench/contrib/chat/test/browser/adapters/filePathResolver.test.ts
```

- `detectFilePaths()`: 단순 파일명 (`knowledge_chat.py`)
- `detectFilePaths()`: 상대 경로 (`backend/routers/chat.py`)
- `detectFilePaths()`: 여러 파일 경로가 한 텍스트에 있을 때
- `detectFilePaths()`: 코드블록 내부 경로 제외
- `detectFilePaths()`: URL 내부 경로 제외
- `detectFilePaths()`: 워크스페이스에 없는 파일은 무시
- `detectFilePaths()`: 버전 번호 오탐 방지

### 9.3 통합 테스트

- Anthropic 어댑터에서 파일 경로 포함 응답 → inlineReference 파트 생성 확인
- 전체 파이프라인: LLM 응답 → FilePathResolver → annotations → InlineAnchorWidget 렌더링

---

## 10. 향후 확장

| 항목 | 설명 |
|------|------|
| 스트리밍 지원 | 현재 Anthropic 어댑터가 스트리밍으로 전환 시, 부분 토큰에서의 파일 경로 감지 버퍼링 필요 |
| 설정 | `intellicen.chat.autoDetectFileLinks` 설정으로 기능 on/off |
| 다른 어댑터 | OpenAI, vLLM 어댑터에도 동일 패턴 적용 |
| 심볼 매칭 | 파일명 뿐 아니라 클래스/함수명도 매칭하여 심볼 참조로 변환 |
