# 전문가 검토 6차 — 5차 반영 패치 구현 검증 (2026-06-12)

검토 대상: [implement_20260612_183255.md](../dev-plan/implement_20260612_183255.md)(5차 검토 반영 패치, Phase 1~4)의 구현. 커밋 `3e2ed42`~`a90cf2d` 포함 범위(`3e2ed42^..a90cf2d`, 17파일 +531/−110).
검토 방법: 로컬 게이트 전 스위트 재현 + 원격 CI 실결과 대조 + M1·M2·M3·L1·L2·L3·L5 항목별 코드·문서 직접 검증.

> 반영 상태: 신규 조치 불요 — 발견 0건(경미 관찰 1건만 기록). 본 검토로 5차 검토 사이클은 **종결**된다.

---

## 0. 총평

**전 항목이 계획대로 정확히 반영되었고, 이전 검토들에서 지적된 프로세스 규율 2건(L4 커밋 granularity, M2 체크박스)이 이번 워크스트림에서 처음으로 완전 준수되었다.** 커밋은 `fix(review5-phase-1)`~`(phase-4)` Phase당 정확히 1개 + 기록 커밋 1개이고, dev plan 체크박스는 본문까지 전부 실상과 일치하며, 구현 중 발견한 이슈(gate-timeout worktree cleanup hang)는 수정 내용과 함께 "이슈 및 수정"에 기록되어 있다. 발견 사항은 높음·중간·낮음 0건, 경미 관찰 1건이다.

## 1. 재현 검증 결과 (2026-06-12 직접 실행)

| 항목                                                | 결과                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck` / `pnpm lint`                      | 통과 / 통과                                                                                            |
| `pnpm test` (unit)                                  | **127 테스트 통과** (5차 시점 121 → +6: M1 5케이스 + L1 절단)                                          |
| `pnpm test:e2e`                                     | 18/18 통과                                                                                             |
| `pnpm build` / `pnpm build:web` / `pnpm test:smoke` | 통과 / 통과 / **4 Playwright 테스트 통과**                                                             |
| 원격 CI                                             | run **27412786156** 그린 + 최신 docs 커밋 run 27412925927도 그린                                       |
| Node.js 20 deprecation annotation                   | **0건** (M3 목표 달성 — 6/16 강제 전환 전 완료)                                                        |
| 푸시 상태                                           | 검토 대상 구현 기준 `main == origin/main`(`a90cf2d`), 본 6차 문서와 README 인덱스 추가분은 미커밋 변경 |
| 커밋 규율 (L4 재발 방지)                            | ✅ `fix(review5-phase-N)` Phase당 단일 커밋 — **첫 완전 준수**                                         |

## 2. 항목별 검증

| 항목                       | 검증 내용                                                                                                                                                                                                                                                                                                                                                                                                                               | 확인 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **M1** same_model_review   | `resolveSameModelReview()` 순수 함수 분리 — strict(`require_different_provider`)→false, `mock:`→false, **LLM 계열·판별 불가→true(보수적)**. `=== 'codex'` 잔존 0건. it.each **5케이스 정확히 구현**(mock/codex/명령 문자열/unknown/strict). EVAL_ENGINE_SPEC §8.1 인근에 의미 명문화("provider independence not guaranteed", schema_version 1.1 이후 기준 — 잔여 리스크의 비마이그레이션 처리까지 반영) + AUTONOMOUS_LOOP_SPEC 상호참조 | ✅   |
| **M3** CI actions          | checkout/setup-node/pnpm action-setup 전부 @v6 (3개 job 일관), CI 그린, deprecation annotation 0건                                                                                                                                                                                                                                                                                                                                      | ✅   |
| **M2** 체크박스 정합       | `dev-plan/implement_20260612_061653.md`의 `grep -c "^- \[ \]"` → **0**, 상태 요약 ↔ 본문 불일치 0건                                                                                                                                                                                                                                                                                                                                     | ✅   |
| **L1** exec 버퍼 상한      | `maxBufferBytes` 옵션 + 기본 16MB + 바이트 단위 절단 + `…[output truncated at …]` 마커, 커스텀 상한(64B) 절단 테스트 존재                                                                                                                                                                                                                                                                                                               | ✅   |
| **L2** safety-resolve 명시 | 코드 주석("anti-hang 우선, 극단 케이스 잔존은 호스트 책임") + EVAL_ENGINE_SPEC gate executor 절 명문화                                                                                                                                                                                                                                                                                                                                  | ✅   |
| **L3** 문서 상호참조       | TASK_PROTOCOL에 repro_command 표시 전용(실행 금지·템플릿 allowlist 후속 조건 포함) + AUTONOMOUS_LOOP_SPEC에 hidden acceptance → EVAL §7.3 위임                                                                                                                                                                                                                                                                                          | ✅   |
| **L5** 배너 갱신           | EXPERT_REVIEW_4(CI 확인 완료)·EXPERT_REVIEW_5(전 항목 반영 완료)·README 갱신                                                                                                                                                                                                                                                                                                                                                            | ✅   |
| 이슈 기록 규율             | gate-timeout fixture의 worktree cleanup hang → timeout 시 pipe destroy/unref + `git worktree remove` 10초 timeout·실패 시 `rm -rf` 폴백, 수정 경위가 "이슈 및 수정"에 기록                                                                                                                                                                                                                                                              | ✅   |

## 3. 경미 관찰 (조치 선택)

### O1. removeWorktree rm 폴백 후 stale 메타데이터 정리 경로 부재

이번 이슈 수정으로 `git worktree remove`가 10초 내 실패하면 worktree 디렉터리를 `rm -rf`로 제거하는데, 이 경로에서는 메인 repo의 `.git/worktrees/<id>` 관리 메타데이터가 남을 수 있다. loop-id가 매번 달라 즉시 path 충돌 가능성은 낮지만, 장기 실행 환경에서는 git metadata 누적·경고·정리 비용으로 번질 수 있다. 현재 `pruneWorktrees()` helper는 존재하지만 rm 폴백 직후나 cleanup call site에서 호출되지 않는다. **권고(선택)**: rm 폴백 직후 `git worktree prune`(safeGit, 짧은 timeout) 1회 호출 또는 주기 gc에 포함. 다음 워크스트림에 한 줄 태스크로 충분하다.

## 4. 종결 선언

- 5차 검토의 M1·M2·M3·L1·L2·L3·L5 전 항목 반영 검증 완료. L4는 본 워크스트림의 커밋 규율로 입증됨.
- 검토 1~5차에서 반영 대상으로 관리된 발견은 반영·검증되었고, 잔여는 기존 후속 과제(컨테이너 격리, LLM critic runner — 도입 시 same_model_review를 실제 모델 비교로 승격, hidden test 보안 저장소, `vibeloop init`)와 O1(선택) 뿐이다.
- 제품 상태: 설계 명세 ↔ 구현 ↔ 테스트 ↔ CI가 정합하며, MVP-0~4 전 구간이 가동 가능 + 신뢰 경계 보강이 적용된 상태다.
