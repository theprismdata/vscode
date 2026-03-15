# IntelliCen Studio — 프로젝트 현황

> 최종 업데이트: 2026-03-15
> 브랜치: `intellicen_ext`
> 앱 이름: **IntelliCen Studio** (`product.json`)

---

## 목표

VS Code 기반으로 Copilot 없이 **vLLM / OpenAI / Anthropic** 등 커스텀 LM 프로바이더만으로 Chat UI + Tool Calling을 사용할 수 있는 오프라인 IDE.

---

## 아키텍처 비교: 전(Before) → 후(After)

### Before (upstream VS Code)

```
Chat Widget
├── Model Picker ← Copilot 모델만 표시
├── SetupAgent ← GitHub 로그인 필수
├── Copilot Extension ← 모든 LM 요청 처리
└── HTTP 요청 ← Copilot 프록시 경유
```

### After (IntelliCen Studio)

```
Chat Widget
├── Model Picker
│   └── My Providers (openai / anthropic / vllm)
├── SetupAgent ← 커스텀 모델 우선 처리 (4단계 로직)
│   ├── 1. 명시적 커스텀 모델 선택 → 즉시 사용
│   ├── 2. 캐시에 커스텀 모델 존재 → 자동 사용
│   ├── 3. 그룹 설정 있지만 미로드 → 최대 8초 대기
│   └── 4. 커스텀 없음 → Copilot 폴백
├── Tool Calling Loop (최대 15회)
│   ├── GPT에 tools 정의 + messages 전송
│   ├── tool_calls 응답 → invokeTool 실행
│   ├── tool_result를 messages에 추가 → 재전송
│   └── 텍스트 응답 → 완료
├── IntelliCen Tool Framework
│   ├── intellicen/framework.ts  → defineIntelliCenTool 패턴
│   ├── intellicen/registry.ts   → 자동 등록
│   └── intellicen/*.ts          → 도구 파일 하나 = 도구 하나
├── CustomVendorProvider (벤더당 1개)
│   ├── provideLanguageModelChatInfo() → 모델 메타데이터 생성
│   └── sendChatRequest() → 벤더별 어댑터 + tools 전달
├── HTTP Adapters (tool calling 지원)
│   ├── openAIAdapter.ts   → POST /v1/chat/completions + tools
│   ├── anthropicAdapter.ts → POST /v1/messages
│   └── vllmAdapter.ts     → POST /v1 또는 /v3 + tools
├── Shared Process IPC
│   ├── RequestChannel     → CORS 우회 HTTP 프록시
│   └── ShellExecChannel   → 렌더러에서 셸 명령 실행
└── System Prompt
    ├── 워크스페이스 경로 자동 주입
    └── 도구 사용 지시 포함
```

---

## 신규 파일

### 핵심 인프라

| 파일 | 역할 |
|------|------|
| `chat/browser/customLanguageModelProviderContribution.ts` | 커스텀 LM 프로바이더 등록, 벤더 디스크립터, 커넥션 테스트 |
| `chat/browser/adapters/openAIAdapter.ts` | OpenAI API (chat completions + tool calling) |
| `chat/browser/adapters/anthropicAdapter.ts` | Anthropic API (messages, system 분리) |
| `chat/browser/adapters/vllmAdapter.ts` | vLLM API (v1/v3 + tool calling) |
| `platform/shell/common/shellExec.ts` | IShellExecService 인터페이스 |
| `platform/shell/common/shellExecIpc.ts` | ShellExec IPC 채널/클라이언트 |
| `platform/shell/node/shellExecService.ts` | ShellExec Node.js 구현 (child_process) |
| `services/shell/electron-browser/shellExecService.ts` | 렌더러용 ShellExec 서비스 (Shared Process 경유) |

### IntelliCen Tool Framework

| 파일 | 역할 |
|------|------|
| `tools/builtinTools/intellicen/framework.ts` | 도구 정의 타입, 자동 변환, 서비스 어댑터 |
| `tools/builtinTools/intellicen/registry.ts` | 모든 도구 자동 등록 (ALL_TOOLS 배열) |
| `tools/builtinTools/intellicen/readFile.ts` | 파일 읽기 도구 |
| `tools/builtinTools/intellicen/listDirectory.ts` | 디렉토리 목록 도구 |
| `tools/builtinTools/intellicen/searchFiles.ts` | 파일 검색 도구 (grep 기반) |
| `tools/builtinTools/intellicen/runTerminalCommand.ts` | 셸 명령 실행 도구 |

### 기타

| 파일 | 역할 |
|------|------|
| `chat/test/browser/customLanguageModelProvider.test.ts` | 유닛 테스트 |
| `product.json` | 앱 이름 변경: Code - OSS → IntelliCen Studio |

---

## 도구 추가 방법 (IntelliCen Tool Framework)

### 2단계로 새 도구 추가

**1단계** — `intellicen/` 폴더에 파일 생성:

```typescript
// intellicen/writeFile.ts
import { IIntelliCenToolDefinition } from './framework.js';

const writeFile: IIntelliCenToolDefinition = {
    id: 'intellicen_writeFile',
    name: 'Write File',
    description: 'Write content to a file',
    toolSet: 'execute',
    parameters: {
        path: { type: 'string', required: true, description: 'File path' },
        content: { type: 'string', required: true, description: 'File content' },
    },
    async invoke(params, services) {
        // services.fileService, services.shellExecService 등 사용 가능
        return 'File written successfully';
    },
};
export default writeFile;
```

**2단계** — `registry.ts`에 import + 배열에 추가:

```typescript
import writeFile from './writeFile.js';

const ALL_TOOLS = [
    readFile, listDirectory, runTerminalCommand, searchFiles,
    writeFile,  // ← 이 한 줄만 추가
];
```

### `invoke()`에서 사용 가능한 서비스

| 서비스 | 설명 |
|--------|------|
| `services.fileService` | 파일 읽기/쓰기/삭제 (`IFileService`) |
| `services.workspaceService` | 워크스페이스 폴더 정보 |
| `services.shellExecService` | 셸 명령 실행 (Shared Process IPC 경유) |
| `services.resolvePath(path)` | 상대경로 → 절대경로 변환 |
| `services.getWorkspaceRoot()` | 워크스페이스 루트 경로 |

### toolSet 종류

| 값 | 도구셋 | 용도 |
|----|--------|------|
| `'read'` | readToolSet | 파일/코드 읽기 전용 |
| `'execute'` | executeToolSet | 명령 실행, 파일 수정 |
| `'vscode'` | vscodeToolSet | VS Code 기능 |
| `'agent'` | agentToolSet | 에이전트 위임 |

---

## 수정된 파일 요약

### 핵심 로직

| 파일 | 변경 내용 |
|------|----------|
| `chat/browser/chat.contribution.ts` | `customLanguageModelProviderContribution.ts` import |
| `chat/common/languageModelsConfiguration.ts` | `ILanguageModelsProviderGroup` 커스텀 필드 추가 |
| `chat/browser/languageModelsConfigurationService.ts` | 커스텀 벤더 JSON 스키마 통합 |
| `chat/common/languageModels.ts` | API 키 입력 후 JSON 파일 자동 열기 방지 |

### 모델 선택 / 피커

| 파일 | 변경 내용 |
|------|----------|
| `widget/input/chatModelSelectionLogic.ts` | Copilot 모델 제거, 커스텀 모델만 표시 |
| `widget/input/chatModelPicker.ts` | "My Providers" 섹션 추가 |
| `widget/input/chatInputPart.ts` | 퍼시스트된 Copilot 모델 복원 방지 |

### Tool Calling + 대화 관리

| 파일 | 변경 내용 |
|------|----------|
| `chatSetup/chatSetupProviders.ts` | 시스템 프롬프트, 대화 히스토리, Tool Calling 루프, 도구 유효성 검사 |

### UI / UX

| 파일 | 변경 내용 |
|------|----------|
| `common/chatModes.ts` | 모드 플레이스홀더 텍스트 변경 |
| `widget/input/modePickerActionItem.ts` | 모드/모델 구분자 `\|` |
| `widget/chatContentParts/chatThinkingContentPart.ts` | "Thought for Xs" 경과 시간 |
| `chatEditing/chatEditingActions.ts` | 버튼 라벨 변경 |
| `widget/media/chat.css` | 레이아웃/스타일 조정 |
| `widgetHosts/viewPane/chatViewPane.ts` | 세션 제목 동적 업데이트 |
| `chatManagement/chatModelsWidget.ts` | 커넥션 테스트 기능 |

### 네트워크 / 인프라

| 파일 | 변경 내용 |
|------|----------|
| `services/request/electron-browser/requestService.ts` | HTTP → Shared Process IPC |
| `code/electron-utility/sharedProcess/sharedProcessMain.ts` | RequestChannel + ShellExecChannel 등록 |
| `code/electron-main/app.ts` | CSP + CORS 설정 |
| `workbench.html`, `workbench-dev.html` | CSP `connect-src` http: 추가 |
| `workbench.desktop.main.ts` | ShellExecService import 추가 |
| `tools/builtinTools/tools.ts` | IntelliCen Tool Framework 등록 |

### 브랜딩

| 파일 | 변경 내용 |
|------|----------|
| `product.json` | 앱 이름: IntelliCen Studio, bundleId, applicationName 등 |

---

## 확인된 동작

- ✅ **vLLM** (Qwen 모델): 정상 응답
- ✅ **OpenAI GPT** (gpt-4o, gpt-4o-mini): 모델 피커 표시 및 선택
- ✅ **Tool Calling**: GPT가 도구 호출 → 결과 반환 → 최종 응답
- ✅ **파일 읽기** (`intellicen_readFile`): 상대/절대 경로 지원
- ✅ **디렉토리 목록** (`intellicen_listDirectory`): 워크스페이스 탐색
- ✅ **셸 명령 실행** (`intellicen_runTerminalCommand`): git, ls 등
- ✅ **파일 검색** (`intellicen_searchFiles`): grep 기반
- ✅ **멀티턴 대화**: 이전 대화 컨텍스트 유지
- ✅ **시스템 프롬프트**: 워크스페이스 경로 + 도구 사용 지시
- ✅ Copilot 모델 피커에서 제거
- ✅ 로그인 다이얼로그 표시 안 됨
- ✅ API 키 입력 후 JSON 파일 자동 열기 안 됨
- ✅ 앱 이름: IntelliCen Studio

---

## 사용자 설정 파일

경로: `~/Library/Application Support/code-oss-dev/User/chatLanguageModels.json`

```json
[
  {
    "vendor": "vllm",
    "name": "prismdata",
    "baseUrl": "http://prismdata.iptime.org:10002",
    "models": ["Qwen3.5-35B-A3B-AWQ-4bit"],
    "defaultModel": "Qwen3.5-35B-A3B-AWQ-4bit",
    "endpointVersion": "v1"
  },
  {
    "name": "OpenAI",
    "vendor": "openai",
    "displayName": "GPT",
    "apiKey": "${input:chat.lm.secret.xxx}",
    "models": ["gpt-4o", "gpt-4o-mini"],
    "defaultModel": "gpt-4o"
  }
]
```

---

## 빌드 및 실행

```bash
# 빌드 (증분 컴파일)
node build/next/index.ts transpile

# 실행
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh

# 타입 체크 (빌드 후 검증)
npm run compile-check-ts-native
```

> ⚠️ `npm run compile` 사용 금지 (monaco.d.ts 검증 실패)
> ⚠️ `monaco.d.ts` 수동 수정 금지

---

## 앞으로 해야 할 것 (TODO)

### 🔴 우선순위: 높음

1. **스트리밍 응답 지원**
   - 현재 모든 어댑터가 `stream: false` (전체 응답 대기 후 한번에 표시)
   - SSE 기반 스트리밍으로 전환 → 사용자 체감 응답 속도 대폭 개선

2. **Anthropic 프로바이더 실제 테스트**
   - `chatLanguageModels.json`에 Anthropic 그룹 추가 후 동작 확인

3. **파일 쓰기 도구 추가** (`intellicen_writeFile`)
   - 프레임워크 기반으로 `intellicen/writeFile.ts` 추가
   - Agent 모드에서 코드 생성/수정 가능

### 🟡 우선순위: 중간

4. **에러 핸들링 강화**
   - API 키 만료/무효 시 사용자 친화적 에러 메시지
   - Rate limit (429) 처리

5. **모델 자동 검색**
   - OpenAI/vLLM `GET /v1/models`로 모델 목록 자동 조회

6. **도구 실행 확인 다이얼로그**
   - 터미널 명령 실행 전 사용자 승인 (현재는 무조건 실행)
   - `prepareToolInvocation` + confirmation flow 연동 필요

7. **시스템 프롬프트 커스터마이징**
   - 사용자 정의 시스템 프롬프트 설정 UI

### 🟢 우선순위: 낮음

8. **토큰 카운터 정확도 개선** (현재 `text.length / 4` 추정)
9. **모델별 maxTokens 설정** (현재 하드코딩)
10. **프로바이더 그룹 UI 개선** (드래그앤드롭, 토글)
11. **Copilot 연동 복구 옵션** (설정으로 토글)
12. **테스트 보강** (어댑터, 도구, 피커)

---

## 알려진 제약사항

- **renderer에서 cross-origin fetch 불가** → Shared Process IPC 경유 필수
- **renderer에서 child_process 불가** → ShellExec IPC 경유 필수
- **`capabilities: { toolCalling: true }`** 없으면 Agent 모드에서 모델 필터링됨
- **빌드:** `node build/next/index.ts transpile` 사용 (npm run compile 금지)
- **시크릿 저장:** apiKey는 `${input:chat.lm.secret.xxx}` 형태로 JSON에 저장, 실제 값은 SecretStorage
- **오프라인 환경:** MCP 서버(npx) 사용 불가 → 빌트인 IntelliCen Tool Framework 사용
