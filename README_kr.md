# IntelliCen Studio — 빌드 및 배포 가이드

IntelliCen Studio는 VS Code(Code-OSS) 포크 기반의 AI 코딩 어시스턴트입니다.
로컬 vLLM 서버와 연동하여 **완전 오프라인** 환경에서 동작합니다.

---

## 1. 빌드 환경 준비

> 참고: https://github.com/microsoft/vscode/wiki/How-to-Contribute

### 1-1. Windows

#### 필수 도구

| 도구 | 버전 | 비고 |
|------|------|------|
| Node.js | **22.22.0 이상** (`.nvmrc` 참조) | https://nodejs.org/ |
| Git | 최신 | https://git-scm.com/ |
| Python | 3.x | `pip install setuptools` 필요 |
| Visual Studio 2022 BuildTools | 17.x | 아래 winget 명령으로 설치 |

#### Visual Studio 2022 BuildTools 설치

Spectre-mitigated 라이브러리를 포함해야 네이티브 모듈(node-pty, spdlog 등)이 빌드됩니다.

**x64 시스템:**
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows11SDK.22621 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.Spectre --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre"
```

**ARM64 시스템:**
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows10SDK.20348 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.ARM64.Spectre --add Microsoft.VisualStudio.Component.VC.MFC.ARM64.Spectre"
```

#### Inno Setup 6 설치 (EXE 인스톨러 생성 시 필요)

```powershell
winget install --id JRSoftware.InnoSetup -e --source winget
```

---

### 1-2. macOS

#### 필수 도구

| 도구 | 버전 | 비고 |
|------|------|------|
| Node.js | **22.22.0 이상** (`.nvmrc` 참조) | https://nodejs.org/ 또는 nvm |
| Git | 최신 | Xcode Command Line Tools에 포함 |
| Xcode | 최신 | App Store에서 설치 — `actool` 사용에 필요 |

#### Xcode 및 Command Line Tools 설치

```bash
# Command Line Tools 설치 확인
xcode-select --install

# Xcode 설치 후 개발자 경로 설정
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

# actool 동작 확인
xcrun --find actool
```

#### code.car 생성 (최초 1회)

macOS 패키징에 필요한 앱 아이콘 Asset Catalog 파일을 생성합니다.

```bash
# code.icns에서 PNG 추출
mkdir -p /tmp/code.iconset
iconutil -c iconset resources/darwin/code.icns -o /tmp/code.iconset

# xcassets 구조 생성
mkdir -p /tmp/code.xcassets/AppIcon.appiconset
cp /tmp/code.iconset/*.png /tmp/code.xcassets/AppIcon.appiconset/

cat > /tmp/code.xcassets/AppIcon.appiconset/Contents.json << 'EOF'
{
  "images" : [
    { "filename": "icon_16x16.png",      "idiom": "mac", "scale": "1x", "size": "16x16" },
    { "filename": "icon_16x16@2x.png",   "idiom": "mac", "scale": "2x", "size": "16x16" },
    { "filename": "icon_32x32.png",      "idiom": "mac", "scale": "1x", "size": "32x32" },
    { "filename": "icon_32x32@2x.png",   "idiom": "mac", "scale": "2x", "size": "32x32" },
    { "filename": "icon_128x128.png",    "idiom": "mac", "scale": "1x", "size": "128x128" },
    { "filename": "icon_128x128@2x.png", "idiom": "mac", "scale": "2x", "size": "128x128" },
    { "filename": "icon_256x256.png",    "idiom": "mac", "scale": "1x", "size": "256x256" },
    { "filename": "icon_256x256@2x.png", "idiom": "mac", "scale": "2x", "size": "256x256" },
    { "filename": "icon_512x512.png",    "idiom": "mac", "scale": "1x", "size": "512x512" },
    { "filename": "icon_512x512@2x.png", "idiom": "mac", "scale": "2x", "size": "512x512" }
  ],
  "info" : { "author": "xcode", "version": 1 }
}
EOF

cat > /tmp/code.xcassets/Contents.json << 'EOF'
{
  "info" : { "author": "xcode", "version": 1 }
}
EOF

# .car 파일 컴파일
xcrun actool --output-format human-readable-text \
  --notices --warnings \
  --platform macosx \
  --minimum-deployment-target 10.15 \
  --app-icon AppIcon \
  --output-partial-info-plist /tmp/partial_info.plist \
  --compile resources/darwin \
  /tmp/code.xcassets

# actool이 Assets.car로 생성하므로 이름 변경
mv resources/darwin/Assets.car resources/darwin/code.car
rm resources/darwin/AppIcon.icns
```

---

## 2. 소스 빌드

### Windows

```powershell
git clone https://github.com/theprismdata/vscode.git
cd vscode

# 의존성 설치 (인터넷 필요)
npm install

# TypeScript 컴파일
npm run compile
```

> `.npmrc`에 `msvs_version="2022"`가 설정되어 있어야 VS2022 BuildTools를 사용합니다.

### macOS

```bash
git clone https://github.com/theprismdata/vscode.git
cd vscode

# 의존성 설치 (인터넷 필요)
npm install

# TypeScript 컴파일
npm run compile
```

---

## 3. 개발 모드 실행

### Windows

```powershell
.\scripts\code.bat
```

### macOS / Linux

```bash
./scripts/code.sh
```

자동 감시 빌드 (소스 수정 시 자동 컴파일):

**Windows:**
```powershell
# 터미널 1: 감시 빌드
npm run watch

# 터미널 2: 앱 실행
.\scripts\code.bat
```

**macOS:**
```bash
# 터미널 1: 감시 빌드
npm run watch

# 터미널 2: 앱 실행
./scripts/code.sh
```

---

## 4. 배포용 패키징

### Windows — 포터블 앱 폴더

```powershell
npm run gulp vscode-win32-x64       # Intel/AMD 64비트
npm run gulp vscode-win32-arm64     # ARM64 (Surface 등)
```

**결과물 위치:** 포터블 패키지는 **저장소 루트(`package.json`이 있는 폴더)의 부모 디렉터리** 아래에 만들어집니다. 폴더 이름은 항상 `VSCode-win32-x64`(또는 ARM64면 `VSCode-win32-arm64`)입니다.

- 예: 클론이 `F:\1.Developing\vscode`이면 → `F:\1.Developing\VSCode-win32-x64\`
- 예: 클론이 `D:\src\vscode`이면 → `D:\src\VSCode-win32-x64\`

이 경로에 폴더가 없다면 `npm run gulp vscode-win32-x64`를 아직 끝까지 실행하지 않았거나, 빌드가 실패했거나, 생성 후 삭제한 경우입니다. 해당 gulp가 성공해야 이 폴더가 생깁니다.

이 폴더째로 배포하거나 ZIP으로 압축하면 **포터블 앱**으로 사용 가능합니다.

### Windows — EXE 인스톨러

```powershell
npm run gulp vscode-win32-x64-system-setup    # x64 시스템 설치용
npm run gulp vscode-win32-x64-user-setup      # x64 사용자 설치용
npm run gulp vscode-win32-arm64-system-setup  # ARM64 시스템 설치용
npm run gulp vscode-win32-arm64-user-setup    # ARM64 사용자 설치용
```

**선행 조건:** 위 setup 작업 전에 같은 아키텍처로 `npm run gulp vscode-win32-x64`(또는 `vscode-win32-arm64`)를 한 번 실행해, **저장소 부모 폴더**에 `VSCode-win32-x64`(또는 `VSCode-win32-arm64`) 패키지 폴더가 있어야 Inno 빌드가 성공합니다.

**결과물 위치** (저장소 루트 기준, `code.iss`의 `OutputBaseFilename`):

| 실행한 태스크 | 폴더·파일 |
|---------------|-----------|
| `*-system-setup` | `.build\win32-x64\system-setup\VSCodeSetup.exe` (또는 `win32-arm64\...`) |
| `*-user-setup` | `.build\win32-x64\user-setup\VSCodeSetup.exe` (또는 `win32-arm64\...`) |

용량은 대략 150MB 전후입니다.

> gulp이 Inno Setup을 자동으로 호출합니다. 수동으로 `iscc` 명령을 실행할 필요 없습니다.

### macOS — .app

> **사전 조건:** `resources/darwin/code.car` 파일이 있어야 합니다. 없으면 섹션 1-2의 code.car 생성 단계를 먼저 실행하세요.

```bash
npm run gulp vscode-darwin-arm64   # Apple Silicon (M1/M2/M3/M4)
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

### Windows — 방법 A: EXE 인스톨러 배포 (권장)

1. 온라인 환경에서 빌드:
   ```powershell
   npm install
   npm run compile
   npm run gulp vscode-win32-x64-system-setup
   ```
2. `.build\win32-x64\system-setup\VSCodeSetup.exe`를 오프라인 머신에 복사
3. 더블클릭으로 설치 (Node.js 불필요)
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### Windows — 방법 B: 포터블 폴더 배포

1. 온라인 환경에서 빌드:
   ```powershell
   npm install
   npm run compile
   npm run gulp vscode-win32-x64
   ```
2. 저장소 부모 폴더의 `VSCode-win32-x64\` 폴더를 ZIP 압축 후 오프라인 머신에 복사
3. 압축 해제 후 `IntelliCen Studio.exe` 실행 (Node.js 불필요)
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### Windows — 방법 C: 소스 빌드 배포 (개발자용)

1. 온라인 환경에서 완료 후 폴더 전체 복사:
   ```powershell
   npm install
   npm run compile
   npm run electron          # .build/electron/ 생성
   ```
2. 대상 머신에 Node.js 22.22.0 이상 설치
3. `.\scripts\code.bat`으로 실행
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### macOS — 방법 A: .app 폴더 배포 (권장)

1. 온라인 환경에서 빌드 (섹션 1-2의 code.car 생성 먼저 완료):
   ```bash
   npm install
   npm run compile
   npm run gulp vscode-darwin-arm64   # Apple Silicon
   # 또는
   npm run gulp vscode-darwin-x64     # Intel Mac
   ```
2. `../VSCode-darwin-arm64/` 폴더를 ZIP 압축 후 오프라인 머신에 복사
3. 압축 해제 후 `IntelliCen Studio.app` 실행 (Node.js 불필요)
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

### macOS — 방법 B: 소스 빌드 배포 (개발자용)

1. 온라인 환경에서 완료 후 폴더 전체 복사:
   ```bash
   npm install
   npm run compile
   npm run electron          # .build/electron/ 생성
   ```
2. 대상 머신에 Node.js 22.22.0 이상 설치
3. `./scripts/code.sh`으로 실행
4. `chatLanguageModels.json` 설정 + 로컬 vLLM 서버 실행

---

## 7. 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| `npm install` 시 MSB8040 Spectre 오류 | VS2022 BuildTools + Spectre 컴포넌트 설치 (섹션 1-1 참조) |
| `npm install` 시 ENOTEMPTY 오류 | `rmdir /s /q node_modules` 후 재실행 |
| `npm install` 시 Node.js 버전 오류 | `.nvmrc` 확인 후 해당 버전 설치 (현재 22.22.0) |
| 앱 실행 시 빈 화면 | `npm run compile` 재실행 후 재시작 |
| 챗 모델 없음 | `chatLanguageModels.json` 설정 확인 |
| 툴 실행 오류 | 워크스페이스 폴더가 열려 있는지 확인 |
| 인스톨러 빌드 실패 (Windows) | Inno Setup 6 설치 여부 확인 |
| `actool` 을 찾을 수 없음 (macOS) | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` 실행 |
| `code.car` 관련 gulp 오류 (macOS) | 섹션 1-2의 code.car 생성 단계 실행 |
| `xcode-select: invalid developer directory` | App Store에서 Xcode 설치 후 재시도 |
