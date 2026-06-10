# PRODUCT_SPEC.md

## 1. 제품 정의

**VibeLoop Harness**는 Codex, Claude Code, Gemini 같은 AI 코딩 에이전트를 반복 실행하되, 검수 룰·회귀 테스트·적대적 평가·개선 증거·사람 승인 게이트를 통과한 코드 개선만 PR 후보로 만드는 자율 코딩 개선 하네스다.

핵심 질문은 “AI가 코드를 작성했는가?”가 아니라 **“이 변경이 진짜 개선임을 재현 가능한 증거로 판정할 수 있는가?”**다.

## 2. 핵심 사용자

| 사용자 | 목적 |
|---|---|
| 개인/소규모 개발자 | 로컬 repo에서 안전한 반복 개선 루프 실행 |
| 팀 리드 | AI 변경이 테스트/보안/회귀 기준을 통과했는지 검토 |
| 플랫폼/DevEx 팀 | 여러 repo의 품질 개선 후보를 표준화된 gate로 운영 |
| 보안/리뷰 담당자 | auth, permission, secret, CI/CD 변경을 human approval로 통제 |

## 3. 제품 원칙

1. **AI는 개선자이지 심판이 아니다.** Builder, evaluator, critic, human reviewer 역할을 분리한다.
2. **테스트 통과는 개선의 필요조건이지 충분조건이 아니다.** 실제 개선 증거가 있어야 한다.
3. **평가 시스템은 보호 대상이다.** eval, CI, protected path, test integrity script 변경은 일반 루프에서 자동 accept하지 않는다.
4. **작은 패치만 자동 루프에 적합하다.** 대규모 리팩터링, DB schema, auth/permission, deployment는 human review가 기본이다.
5. **모든 판단은 artifact로 남는다.** diff, logs, gate outputs, metrics, decision reasons를 보존한다.

## 4. MVP 제품 범위

### 포함

- 단일 repo 등록 또는 로컬 경로 지정
- task.yaml 기반 작업 생성
- git worktree 기반 isolated workspace
- 단일 agent adapter 실행
- candidate patch 생성
- eval.yaml 기반 gate 실행
- robust diff scope / test integrity / protected file / git metadata / limits guard (하네스 내장)
- baseline capture + test-on-base 기반 개선 증거 검증
- eval-report.json 생성
- `accept | reject | needs_human_review | needs_more_tests` 판정
- 정적 HTML 또는 CLI report 출력

### 제외

- 멀티 tenant billing
- 자동 merge
- agent rotation
- 완전한 스킬 마켓
- 대규모 병렬 실행
- 복잡한 웹 시각화
- 클라우드 runner provider

## 5. 성공 기준

| 기준 | 수용 조건 |
|---|---|
| 평가 없는 반영 금지 | 모든 patch는 eval-report.json 없이는 PR 생성 불가 |
| test weakening 차단 | 테스트 skip/삭제/약화가 gate에서 reject |
| scope escape 차단 | allowed path 밖 변경, untracked file, symlink 우회 reject |
| protected path 차단 | eval/CI/secret/protected path 변경은 reject 또는 meta-eval |
| 위험 변경 통제 | auth/permission/DB/deploy/CI/eval은 human review |
| 재현성 | base commit, patch, command log, env snapshot으로 재실행 가능 |
| 증거 기반 판단 | 개선 증거가 없으면 reject 또는 needs_more_tests |

## 6. 제품 포지셔닝

이 제품은 “AI 코딩 자동화 UI”가 아니다. 핵심은 **candidate patch를 검증 가능한 단위로 격리하고, deterministic gates로 판정하는 개발 안전 하네스**다.
