#!/usr/bin/env bash
# 앱 저장소(duetden)에서 SD 렌더·검사 코드와 바디·키트를 그대로 복사한다.
# 앱 쪽 규칙이 바뀌면 이 스크립트를 다시 돌리고 커밋하면 웹도 똑같이 동작한다.
# 사용: scripts/sync-from-app.sh ../duetden
set -euo pipefail
APP="${1:-../duetden}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HERE/src/app" "$HERE/public/app-assets" "$HERE/public/kit"
cp "$APP/mobile/src/features/space/sd/kit/sdKit.ts" "$HERE/src/app/sdKit.ts"
cp "$APP/mobile/src/features/space/sd/sdCatalog.ts" "$HERE/src/app/sdCatalog.ts"
cp "$APP/mobile/src/features/space/sd/catalog.generated.ts" "$HERE/src/app/catalog.generated.ts"
cp "$APP/mobile/src/features/space/sd/sdModel.ts" "$HERE/src/app/sdModel.ts"
cp "$APP"/mobile/assets/character-sd/*.webp "$HERE/public/app-assets/"
for sex in male female; do
  rm -rf "$HERE/public/kit/$sex"; mkdir -p "$HERE/public/kit/$sex"
  cp "$APP/character-assets/sd/kit/$sex/spec.json" "$HERE/public/kit/$sex/"
  cp -r "$APP/character-assets/sd/kit/$sex/masks" "$HERE/public/kit/$sex/"
done
( cd "$APP" && echo "{\"commit\":\"$(git rev-parse --short HEAD)\",\"date\":\"$(git log -1 --format=%cs)\"}" ) > "$HERE/src/app/source.json"
echo "synced from $APP"
