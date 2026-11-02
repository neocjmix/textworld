# CJK monospace 선택과 실측

조사·실측: 2026-11-02. 사용자가 이전의 일반 글꼴 조건을 바꾸어 CJK를 지원하는 monospace 계열을 직접 적용하라고 요청했다.

## 선택

**Sarasa Fixed K Regular 1.0.43**을 자체 제공한다. Sarasa는 Iosevka의 Latin/Greek/Cyrillic과 Source Han Sans의 CJK를 결합한 글꼴이다. 공식 문서는 Fixed를 ligature가 없고 em dash가 반각인 변형으로 설명한다. 한국어 중심인 현재 앱에는 K 지역형을 선택하지만 일본어·중국어 문자도 포함한다.

| 후보 | 확인한 근거와 판단 |
| --- | --- |
| Sarasa Mono K | CJK monospace 계열이지만 공식 문서상 em dash가 전각이며 ligature를 제공한다. 현재 공간 폭 규칙의 ambiguous=1과 더 잘 맞는 Fixed를 선택했다. |
| **Sarasa Fixed K** | **Latin/Greek/Cyrillic도 일정한 반각, CJK 전각, ligature 없음. 실제 파일·브라우저 실측에서 1:2 폭을 확인했다.** |
| Noto Sans Mono CJK KR | 공식 문서는 언어별 전체 문자 범위를 제공하며 Mono가 ASCII를 반각으로 사용한다고 설명한다. 적합한 대안이지만 이번에는 좁은 em dash와 ligature 제거가 명시된 Sarasa Fixed를 선택했다. Noto의 모든 문자를 직접 실측한 것은 아니다. |
| 시스템 `monospace`만 지정 | 설치된 플랫폼 글꼴에 따라 CJK 대체 글꼴·폭·모양이 달라진다. 같은 공간을 보는 사용자에게 일관된 표시를 주기 위해 파일을 직접 제공한다. |

## 배포 파일과 라이선스

- 공식 릴리스: [Sarasa Gothic v1.0.43](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43)
- 공식 소스 아카이브: [SarasaFixedK-TTF-Unhinted-1.0.43.7z](https://github.com/be5invis/Sarasa-Gothic/releases/download/v1.0.43/SarasaFixedK-TTF-Unhinted-1.0.43.7z)
- 버전 고정 라이선스 원문: [LICENSE](https://github.com/be5invis/Sarasa-Gothic/blob/v1.0.43/LICENSE)
- 저장 파일: `public/fonts/sarasa-fixed-k-regular-1.0.43.woff2`
- 라이선스 동봉: `public/fonts/OFL-Sarasa.txt`, SIL Open Font License 1.1
- 소스·결과 SHA-256과 변환 기록: `public/fonts/provenance.json`

Regular 한 굵기를 FontTools 4.61.1로 WOFF2 컨테이너로 변환했다. 문자 subset·outline·advance 변경은 하지 않았다. TTF와 최종 WOFF2를 다시 읽어 cmap과 전체 hmtx metric이 같은지 확인했다. 최종 파일은 **5,315,944 bytes (약 5.07 MiB)**다. 별도의 외부 글꼴 CDN 호출은 필요 없다.

## 폭과 문자 범위 검증

원본 UPM은 1000이며 반각 advance 500, CJK 전각 advance 1000이다. 최종 WOFF2를 실제 Chromium에서 로드한 뒤 Canvas `measureText()`를 사용했다.

| 18px 글꼴 크기에서 입력 | 측정 advance |
| --- | --- |
| `i`, `W`, `M`, `é`, `é`, `Ω`, `—`, `ｶ` | 약 9px 각각 |
| `한`, `글`, `한`, `中`, `文`, `あ`, `ア`, `Ａ` | 약 18px 각각 |

소수점 차이는 0.001px 미만이었다. ASCII `W`를 좁히기 위해 수평 압축할 필요가 없다. 기존 12px/24px 배치를 9px/18px로 줄이면 영문과 CJK 모두 25% 더 촘촘해지고, 18px 글꼴 본래의 문자 형태는 유지된다. 권장 기본 행 높이는 26px이며 zoom에 비례한다. 브라우저가 처음 대체 글꼴로 그리지 않도록 `FontFace.load()` 또는 `document.fonts.load()` 완료 후 지도 렌더링과 입력을 시작한다. 버전 경로 WOFF2는 immutable 캐시 대상으로 둘 수 있다.

파일은 54,195 glyph / 51,228 Unicode 문자 mapping을 갖는다. cmap에서 다음 범위 전체가 존재하는지 확인했다.

- Hangul syllables: 11,172 / 11,172
- Basic Han: 20,992 / 20,992
- CJK Extension A: 6,592 / 6,592
- Hiragana letters U+3041–U+3096: 86 / 86
- Katakana letters U+30A1–U+30FA: 90 / 90

모든 Unicode 17 추가 문자와 모든 이모지를 포함한다는 의미는 아니다. K는 한국 지역 자형을 기본으로 삼으므로 같은 한자의 국가별 세부 자형까지 개별 언어에 따라 자동 선택하는 제품 정책은 별도다.

`artifacts/sarasa-font-measure.png`를 직접 열어 한국어·일본어·중국어·영문 혼합 행의 간격과 형태를 확인했다. 실측 JSON은 `artifacts/sarasa-font-metrics.json`에 있다. 이 글꼴 실측은 실제 OS 키보드의 IME 검증과 구분한다.

## 읽은 공식 자료

- [Sarasa README: 구성과 Mono/Term/Fixed 차이](https://github.com/be5invis/Sarasa-Gothic)
- [Sarasa 릴리스 목록](https://github.com/be5invis/Sarasa-Gothic/releases)
- [Noto Sans CJK 배포 형식과 Mono 설명](https://github.com/notofonts/noto-cjk/blob/main/Sans/README.md)

검색은 Exa로 공식 자료를 찾고 본문을 읽었으며, 실제 font asset은 공식 GitHub 릴리스에서 받았다. 아카이브 checksum과 로컬/브라우저 검증은 검색 스니펫을 대신하는 직접 확인이다.
