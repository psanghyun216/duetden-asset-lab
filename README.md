# duetden 에셋 랩

SD 캐릭터 에셋을 만들자마자 폰에서 바로 입혀 보고 검사하는 웹 도구입니다.

- 앱(duetden)과 **같은 코드**로 그립니다: `src/app/`의 `sdModel.ts`·`sdCatalog.ts`·`sdKit.ts`·`catalog.generated.ts`는 앱 저장소 파일을 그대로 복사한 것입니다(레이어 순서·좌표·기본값·성별 규칙 동일).
- 앱에 올라간 에셋은 `https://api.duetden.com/sd/catalog`에서 그때그때 읽어 옵니다(다른 서버는 `?api=https://...`).
- 파일 첨부는 관리 페이지 업로드와 같은 순서로 처리합니다: 배경 지우기 → 1000x1000 → 바디에 자동 맞춤 → (헤어 한 장이면 턱선에서 앞/뒤 나누기, 표정이면 눈 간격 맞춤) → 키트 구역 검사. 통과/불통과와 문제 위치(빨강)를 보여 주고, 맞춘 그림을 앱 파일 이름 규칙대로 내려받을 수 있습니다.
- 첨부한 파일은 브라우저 안에서만 쓰이고 어디에도 저장되지 않습니다.

## 앱 규칙이 바뀌었을 때

```
scripts/sync-from-app.sh ../duetden   # 앱 코드·바디·키트 다시 복사
npm run build                          # dist/ 생성
```

`main`에 푸시하면 GitHub Actions가 빌드해 GitHub Pages(`gh-pages` 브랜치)에 올립니다.

`src/pr73.ts`·`public/pr73/`은 앱 PR #73(기본 헤어)이 병합되기 전 임시입니다. 병합 뒤 sync 하고 지우면 됩니다.
