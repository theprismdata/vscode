# IntelliCen Studio — 오프라인 배포 가이드

IntelliCen Studio는 VS Code(Code-OSS) 포크 기반의 AI 코딩 어시스턴트입니다.
로컬 vLLM 서버와 연동하여 **완전 오프라인** 환경에서 동작합니다.

---

## 구성 요소

| 구성 요소 | 경로 | 역할 |
|-----------|------|------|
| Electron 앱 | `.build/electron/IntelliCen Studio.app` | 실행 바이너리 (macOS) |
| 컴파일 결과 | `out/` | TypeScript → JS 빌드 결과 |
| 의존성 | `node_modules/` | npm 패키지 전체 |
| 빌트인 확장 | `.build/builtInExtensions/` | 내장 언어 확장 |
| LLM 설정 파일 (개발 모드) | `~/Library/Application Support/code-oss-dev/User/chatLanguageModels.json` | 모델 공급자 설정 |
| LLM 설정 파일 (패키징 앱) | `~/Library/Application Support/IntelliCen Studio/User/chatLanguageModels.json` | 모델 공급자 설정 |

---

## 1. 최초 1회: 인터넷 연결 상태에서 준비

> 이미 완료된 경우 건너뜁니다.

```bash
# Node.js 22 이상 필요
node --version   # v22.x.x 확인

# 의존성 설치 (인터넷 필요 — 최초 1회만)
npm install

# 빌트인 확장 다운로드 (최초 1회만)
npm run download-builtin-extensions

# TypeScript 컴파일 (이후에는 인터넷 불필요)
npm run compile
```

---

## 2. 개발 모드 실행

### 온라인 환경 (최초 실행 또는 업데이트 시)

```bash
./scripts/code.sh
```

- `preLaunch.ts`가 실행되어 Electron 버전·빌트인 확장을 확인합니다.
- Electron 버전이 일치하면 다운로드를 건너뜁니다 (수정된 동작).

### 오프라인 환경 (빌드 완료 후 인터넷 없이 실행)

```bash
./scripts/code-offline.sh
```

- `VSCODE_SKIP_PRELAUNCH=1` — Electron 다운로드·확장 동기화 전체 건너뜀
- `.build/electron/` 또는 `out/` 폴더가 없으면 오류 메시지 출력 후 종료

자동 감시 빌드 (소스 수정 시 자동 컴파일):
```bash
# 별도 터미널에서 실행
npm run watch

# 앱은 별도 터미널에서 실행
./scripts/code-offline.sh
```

---

## 3. 배포용 앱 패키징

### macOS (.app)

```bash
npm run gulp vscode-darwin-arm64   # Apple Silicon
npm run gulp vscode-darwin-x64     # Intel Mac
```

결과물: `../VSCode-darwin-arm64/IntelliCen Studio.app`  
이 `.app` 파일 하나만 복사하면 다른 Mac에서 실행 가능합니다.

---

### Windows (포터블 폴더 · EXE 인스톨러)

> **반드시 Windows 머신에서 실행해야 합니다.**  
> Electron 크로스 컴파일과 Inno Setup이 Windows 환경을 요구합니다.

> **IntelliCen Studio는 Electron 데스크톱 앱입니다.**  
> Node.js CLI 앱에 쓰는 `caxa` 방식의 단일 `.exe` 번들은 사용할 수 없습니다.  
> Electron 앱은 런타임(Chromium + Node.js)을 포함한 폴더 또는 Inno Setup 인스톨러로 배포합니다.

#### 1단계: Windows 머신에서 준비

```powershell
# Node.js 22 이상, Git 설치 후
git clone https://github.com/theprismdata/vscode.git
cd vscode
npm install
npm run compile
npm run download-builtin-extensions
```

#### 2단계: 포터블 앱 폴더 생성

```powershell
npm run gulp vscode-win32-x64       # Intel/AMD 64비트
npm run gulp vscode-win32-arm64     # ARM64 (Surface 등)
```

결과물: `..\VSCode-win32-x64\` 폴더 (~300MB)  
이 폴더째로 배포하거나 ZIP으로 압축하면 **포터블 앱**으로 사용 가능합니다.  
Node.js 설치 불필요 — Electron 런타임이 내장되어 있습니다.

#### 3단계: EXE 인스톨러 생성 (선택)

[Inno Setup 6](https://jrsoftware.org/isinfo.php)을 설치한 후:

```powershell
# x64 시스템 설치용
iscc /dNameLong="IntelliCen Studio" `
     /dNameShort="IntelliCen Studio" `
     /dVersion="1.112.0" `
     /dRawVersion="1.112.0" `
     /dNameVersion="IntelliCen Studio 1.112.0" `
     /dSourceDir="..\VSCode-win32-x64" `
     /dRepoDir="." `
     /dOutputDir="..\installer-output" `
     /dInstallTarget="system" `
     "/dAppId={{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}" `
     /dDirName="IntelliCen Studio" `
     /dExeBasename="intellicen-studio" `
     /dArchitecturesAllowed="x64compatible" `
     /dArchitecturesInstallIn64BitMode="x64compatible" `
     build\win32\code.iss

# ARM64 시스템 설치용
iscc /dNameLong="IntelliCen Studio" `
     /dNameShort="IntelliCen Studio" `
     /dVersion="1.112.0" `
     /dRawVersion="1.112.0" `
     /dNameVersion="IntelliCen Studio 1.112.0" `
     /dSourceDir="..\VSCode-win32-arm64" `
     /dRepoDir="." `
     /dOutputDir="..\installer-output" `
     /dInstallTarget="system" `
     "/dAppId={{D1ACE434-89C5-48D1-88D3-E2991DF85475}" `
     /dDirName="IntelliCen Studio" `
     /dExeBasename="intellicen-studio" `
     /dArchitecturesAllowed="arm64" `
     /dArchitecturesInstallIn64BitMode="arm64" `
     build\win32\code.iss
```

결과물: `..\installer-output\VSCodeSetup.exe` — 더블클릭 설치 가능한 인스톨러

> **MSI 형식은 지원하지 않습니다.** VS Code 빌드 시스템은 Inno Setup `.exe`만 지원합니다.

---

### 참고: local-code-rag (`cen.exe`) 방식과의 차이

`local-code-rag` 프로젝트의 `cen.exe`는 **caxa**로 만든 단일 파일 CLI 실행 파일입니다.

| 항목 | local-code-rag (CLI) | IntelliCen Studio (데스크톱) |
|------|---------------------|----------------------------|
| 앱 타입 | Node.js CLI | Electron 데스크톱 앱 |
| 런타임 번들러 | caxa (Node.js 내장) | Electron 내장 |
| Windows 배포 | 단일 `.exe` 파일 | 폴더 또는 Inno Setup EXE |
| caxa 적용 가능 | 가능 | 불가 |

---

## 4. LLM 모델 설정 (오프라인 vLLM 연동)

앱 실행 후 챗 입력창의 모델 선택 버튼으로 설정하거나,
직접 파일을 편집합니다.

**설정 파일 위치:**

| 실행 방식 | 경로 |
|----------|------|
| 개발 모드 (`code.sh` / `code-offline.sh`) | `~/Library/Application Support/code-oss-dev/User/chatLanguageModels.json` |
| 패키징 `.app` 실행 | `~/Library/Application Support/IntelliCen Studio/User/chatLanguageModels.json` |
| Windows 패키징 | `%APPDATA%\IntelliCen Studio\User\chatLanguageModels.json` |

**설정 예시:**
```json
[
  {
    "vendor": "vllm",
    "name": "로컬 Qwen",
    "baseUrl": "http://localhost:10002",
    "models": ["Qwen3.5-35B-A3B-AWQ-4bit"],
    "defaultModel": "Qwen3.5-35B-A3B-AWQ-4bit",
    "endpointVersion": "v1"
  },
  {
    "vendor": "vllm",
    "name": "사내 LLM",
    "baseUrl": "http://10.10.41.160:8080",
    "models": ["CEN-35B"],
    "defaultModel": "CEN-35B",
    "endpointVersion": "v1"
  },
  {
    "vendor": "anthropic",
    "name": "Anthropic",
    "apiKey": "sk-ant-...",
    "models": ["claude-sonnet-4-6"],
    "defaultModel": "claude-sonnet-4-6"
  },
  {
    "vendor": "openai",
    "name": "OpenAI",
    "apiKey": "sk-...",
    "models": ["gpt-4o", "gpt-4o-mini"],
    "defaultModel": "gpt-4o"
  }
]
```

> API 키는 앱 UI에서 입력하면 시크릿 스토어에 저장되며,  
> 설정 파일에는 `"${input:chat.lm.secret.xxxxx}"` 형태로 참조됩니다.

---

## 5. 완전 오프라인 배포 체크리스트

### 방법 A: 소스 빌드 배포 (개발자용)

오프라인 환경의 다른 머신에 소스째로 배포:

- [ ] 온라인 환경에서 아래를 완료한 후 폴더 전체 복사
  ```bash
  npm install                          # node_modules/ 생성
  npm run compile                      # out/ 생성
  npm run download-builtin-extensions  # .build/builtInExtensions/ 생성
  npm run electron                     # .build/electron/ 생성
  ```
- [ ] Node.js 22 이상 설치 (타겟 머신)
- [ ] `./scripts/code-offline.sh` 로 실행 (인터넷 불필요)
- [ ] 로컬 vLLM 서버 실행 중 + `chatLanguageModels.json` 설정

### 방법 B: 패키징 배포 (배포용, 권장)

**macOS:**
```bash
npm run gulp vscode-darwin-arm64   # Apple Silicon
# npm run gulp vscode-darwin-x64  # Intel Mac
```
- [ ] `../VSCode-darwin-arm64/IntelliCen Studio.app` 복사
- [ ] 로컬 vLLM 서버 실행 중 + `chatLanguageModels.json` 설정

**Windows (Windows 머신에서 빌드):**
```powershell
npm run gulp vscode-win32-x64
# 결과: ..\VSCode-win32-x64\ 폴더 → ZIP 압축 후 배포
# EXE 인스톨러 원할 경우: Inno Setup으로 code.iss 컴파일
```
- [ ] `VSCode-win32-x64\` 폴더 또는 EXE 인스톨러 배포
- [ ] 로컬 vLLM 서버 실행 중 + `chatLanguageModels.json` 설정

> **패키징된 앱은 Node.js 불필요** — Electron이 내장되어 있습니다.

---

## 6. 빌드 결과물 폴더 설명

```
vscode/
├── out/                        # 컴파일된 JS (npm run compile 결과)
├── .build/
│   ├── electron/               # Electron 바이너리 (.app / .exe)
│   └── builtInExtensions/      # 내장 언어 확장
├── node_modules/               # npm 의존성
├── extensions/                 # VS Code 기본 확장 소스
└── scripts/
    ├── code.sh                 # 개발 모드 실행 (버전 체크 포함)
    └── code-offline.sh         # 오프라인 실행 (preLaunch 전체 건너뜀)
```

---

## 7. 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| 앱 실행 시 빈 화면 | `npm run compile` 재실행 후 재시작 |
| 챗 모델 없음 | `chatLanguageModels.json` 설정 확인 |
| 툴 실행 오류 | 워크스페이스 폴더가 열려 있는지 확인 |
| Electron 버전 오류 | `node node_modules/.bin/electron --version` 확인 (v22 필요) |
| 컴파일 오류 | `node --version` 확인 (v22 이상 필요) |
