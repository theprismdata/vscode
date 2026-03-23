#!/usr/bin/env bash
# IntelliCen Studio — 오프라인 실행 스크립트
#
# 최초 1회 빌드(`npm run compile` + `npm run download-builtin-extensions`)가
# 완료된 이후 인터넷 없이 실행할 때 사용합니다.
#
# 일반 code.sh와의 차이:
#   VSCODE_SKIP_PRELAUNCH=1 → preLaunch.ts 전체를 건너뜁니다.
#   (Electron 다운로드 · npm ci · 빌트인 확장 동기화 모두 생략)

set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f $0)")")
fi

cd "$ROOT"

# 필수 폴더 사전 검증
if [[ ! -d ".build/electron" ]]; then
	echo "ERROR: .build/electron/ 폴더가 없습니다."
	echo "먼저 온라인 환경에서 'npm run compile' 을 실행해 주세요."
	exit 1
fi

if [[ ! -d "out" ]]; then
	echo "ERROR: out/ 폴더가 없습니다."
	echo "먼저 온라인 환경에서 'npm run compile' 을 실행해 주세요."
	exit 1
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
	NAME=$(node -p "require('./product.json').nameLong")
	EXE_NAME=$(node -p "require('./product.json').nameShort")
	CODE="./.build/electron/$NAME.app/Contents/MacOS/$EXE_NAME"
else
	NAME=$(node -p "require('./product.json').applicationName")
	CODE=".build/electron/$NAME"
fi

export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1
export VSCODE_SKIP_PRELAUNCH=1   # preLaunch.ts 건너뜀 → 인터넷 불필요

DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"
if [[ "$@" == *"--extensionTestsPath"* ]]; then
	DISABLE_TEST_EXTENSION=""
fi

exec "$CODE" . $DISABLE_TEST_EXTENSION "$@"
