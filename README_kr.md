# IntelliCen Studio — 빌드 및 배포 가이드

IntelliCen Studio는 VS Code(Code-OSS) 포크 기반의 AI 코딩 어시스턴트입니다.
로컬 vLLM 서버와 연동하여 **완전 오프라인** 환경에서 동작합니다.

---

## 1. 빌드 환경 준비 (Windows)

> 참고: https://github.com/microsoft/vscode/wiki/How-to-Contribute

### 필수 도구

| 도구 | 버전 | 비고 |
|------|------|------|
| Node.js | **22.22.0 이상** (`.nvmrc` 참조) | https://nodejs.org/ |
| Git | 최신 | https://git-scm.com/ |
| Python | 3.x | `pip install setuptools` 필요 |
| Visual Studio 2022 BuildTools | 17.x | 아래 winget 명령으로 설치 |

### Visual Studio 2022 BuildTools 설치

Spectre-mitigated 라이브러리를 포함해야 네이티브 모듈(node-pty, spdlog 등)이 빌드됩니다.

**x64 시스템:**
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows11SDK.22621 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.Spectre --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre"
```

**ARM64 시스템:**
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows10SDK.20348 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.ARM64.Spectre --add Microsoft.VisualStudio.Component.VC.MFC.ARM64.Spectre"
```

### Inno Setup 6 설치 (EXE 인스톨러 생성 시 필요)

```powershell
winget install --id JRSoftware.InnoSetup -e --source winget
```

---

## 2. 소스 빌드

```powershell
git clone https://github.com/theprismdata/vscode.git
cd vscode

# 의존성 설치 (인터넷 필요)
npm install

# TypeScript 컴파일
npm run compile
```

> `.npmrc`에 `msvs_version="2022"`가 설정되어 있어야 VS2022 BuildTools를 사용합니다.

---

## 3. 개발 모드 실행

### Windows

```powershell
.\scripts\code.bat
```

### macOS / Linux

```bash
# 온라인 (Electron 다운로드 포함)
./scripts/code.sh

# 오프라인 (빌드 완료 후)
./scripts/code-offline.sh
```

자동 감시 빌드 (소스 수정 시 자동 컴파일):
```powershell
# 터미널 1: 감시 빌드
npm run watch

# 터미널 2: 앱 실행
.\scripts\code.bat
```

---

## 4. 배포용 패키징

### Windows — 포터블 앱 폴더

```powershell
npm run gulp vscode-win32-x64       # Intel/AMD 64비트
npm run gulp vscode-win32-arm64     # ARM64 (Surface 등)
```

결과물: `..\VSCode-win32-x64\` 폴더
이 폴더째로 배포하거나 ZIP으로 압축하면 **포터블 앱**으로 사용 가능합니다.

### Windows — EXE 인스톨러

```powershell
npm run gulp vscode-win32-x64-system-setup    # x64 시스템 설치용
npm run gulp vscode-win32-x64-user-setup      # x64 사용자 설치용
npm run gulp vscode-win32-arm64-system-setup  # ARM64 시스템 설치용
npm run gulp vscode-win32-arm64-user-setup    # ARM64 사용자 설치용
```

결과물: `.build\win32-x64\system-setup\VSCodeSetup.exe` (~151MB)

> gulp이 Inno Setup을 자동으로 호출합니다. 수동으로 `iscc` 명령을 실행할 필요 없습니다.

### macOS — .app

```bash
npm run gulp vscode-darwin-arm64   # Apple Silicon
npm run gulp vscode-darwin-x64     # Intel Mac
```

결과물: `../VSCode-darwin-arm64/IntelliCen Studio.app`

> **패키징된 앱은 Node.js 설치 불필요** — Electron 런타임이 내장되어 있습니다.
> 오프라인 환경에 복사하면 바로 실행됩니다.

---

## 5. LLM 모델 설정

앱 실행 후 챗 입력창의 모델 선택 버튼으로 설정하거나, 직접 파일을 편집합니다.

**설정 파일 위치:**

| 실행 방식 | 경로 |
|----------|------|
| 개발 모드 (Windows) | `%APPDATA%\code-oss-dev\User\chatLanguageModels.json` |
| 개발 모드 (macOS) | `~/Library/Application Support/code-oss-dev/User/chatLanguageModels.json` |
| 패키징 앱 (Windows) | `%APPDATA%\IntelliCen Studio\User\chatLanguageModels.json` |
| 패키징 앱 (macOS) | `~/Library/Application Support/IntelliCen Studio/User/chatLanguageModels.json` |

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

## 6. 오프라인 배포 체크리스트

### 방법 A: EXE 인스톨러 배포 (권장)

1. 온라인 환경에서 빌드:
   ```powershell
   npm install
   npm run compile
   npm run gulp vscode-win32-x64-system-setup
   ```
2. `.build\win32-x64\system-setup\VSCodeSetup.exe`를 오프라인 머신에 복사
3. 더블클릭으로 설치 (Node.js 불필요)
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### 방법 B: 포터블 폴더 배포

1. 온라인 환경에서 빌드:
   ```powershell
   npm install
   npm run compile
   npm run gulp vscode-win32-x64
   ```
2. `..\VSCode-win32-x64\` 폴더를 ZIP 압축 후 오프라인 머신에 복사
3. 압축 해제 후 `IntelliCen Studio.exe` 실행 (Node.js 불필요)
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### 방법 C: 소스 빌드 배포 (개발자용)

1. 온라인 환경에서 완료 후 폴더 전체 복사:
   ```powershell
   npm install
   npm run compile
   npm run electron          # .build/electron/ 생성
   ```
2. 대상 머신에 Node.js 22.22.0 이상 설치
3. `.\scripts\code.bat`으로 실행
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

---

## 7. 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| `npm install` 시 MSB8040 Spectre 오류 | VS2022 BuildTools + Spectre 컴포넌트 설치 (섹션 1 참조) |
| `npm install` 시 ENOTEMPTY 오류 | `rmdir /s /q node_modules` 후 재실행 |
| `npm install` 시 Node.js 버전 오류 | `.nvmrc` 확인 후 해당 버전 설치 (현재 22.22.0) |
| 앱 실행 시 빈 화면 | `npm run compile` 재실행 후 재시작 |
| 챗 모델 없음 | `chatLanguageModels.json` 설정 확인 |
| 툴 실행 오류 | 워크스페이스 폴더가 열려 있는지 확인 |
| 인스톨러 빌드 실패 | Inno Setup 6 설치 여부 확인 |
