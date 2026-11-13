# 시험 책임 이동

## 브라우저 시험

Playwright는 현재 프런트엔드 빌드와 `Scenario`의 애플리케이션 API 응답을 사용한다. HTTP와 WebSocket은 브라우저 문맥에서 가로챈다. 한 시험의 문서 저장 상태는 같은 시험의 탭과 추가 문맥에서 공유하고, 다음 시험에서는 새로 만든다. 원천 수집이나 계산은 브라우저 자료 생성기가 실행하지 않는다.

다음 표는 기존 혼합 시험에서 브라우저 밖으로 옮긴 책임을 기록한다. 화면 동작은 해당 spec에 남는다. 응답값은 화면 시험의 입력이며 서버 계산 결과를 검증한 근거로 세지 않는다.

| 기존 시험 | 남은 브라우저 검증 | 서버·도메인 검증 소유자 |
| --- | --- | --- |
| `realtime.spec.ts`: 체결마다 일봉 현재 봉이 움직이고 키움 강제 단절 뒤 이어짐 | `일봉 현재 봉과 재연결 상태를 표시하고 연결 회복 뒤 갱신을 이어간다` | `domain::aggregate::tests::aggregate_table`; `kiwoom::stream::tests::a_dropped_session_goes_down_then_logs_in_again_with_the_same_token_and_registers_everything` |
| `realtime.spec.ts`: 다음 분 체결의 봉 확정과 신규 봉 | `확정 분봉 뒤 새 현재 봉을 받고 기존 봉과 함께 표시한다` | `domain::aggregate::tests::roll_reports_the_confirmed_bar`; `domain::aggregate::tests::aggregate_table` |
| `realtime.spec.ts`: 재구성 세션 REG 거절 | `실시간 중단 상태에서도 HTTP 조회 차트와 주기 전환을 유지한다` | `kiwoom::stream::tests::a_registration_refused_for_capacity_rebuilds_once_then_halts_only_the_stream` |
| `watchlist-realtime.spec.ts`: 체결의 시세·봉 동시 반영 | 명시적인 `quotes`와 `bar`를 받은 뒤 관심종목과 차트 표시, REST 반복 방지 | `kiwoom::stream::tests::trades_become_ticks_and_auction_only_frames_are_dropped`; `domain::aggregate::tests::aggregate_table` |
| `watchlist-realtime.spec.ts`: 200자리 초과 후 등록 재배치 | `watch_limited` 표시·해제, 목록 편집과 조회 횟수 | `kiwoom::stream::tests::replacing_one_of_two_hundred_registrations_removes_before_it_registers` |
| `quarter-year.spec.ts`: Q/Y 응답과 현재 봉 | Q/Y 선택, 응답 표시, 실시간 프레임 적용, 이동평균·비교·드로잉·설정 복원, 최초·과거 조회 실패 UI | `bars::tests::quarterly_pages_hold_boundary_months_deduplicate_and_keep_listing_quarter`; `bars::tests::quarterly_initial_and_mid_page_failure_never_seed_or_return_a_partial_quarter`; `domain::aggregate::tests::quarterly_and_yearly_seeds_update_and_roll_into_the_next_calendar_bucket` |
| `ten-minute.spec.ts`, `indicators.spec.ts`, `pending-frame-series.spec.ts`, `theme-held-frame.spec.ts`의 원천 체결 입력 | 명시적인 분봉 프레임 순서에서 지표·거래량·드로잉·worker·프레임 표시 검증 | `domain::aggregate::tests::aggregate_table`; `domain::aggregate::tests::roll_reports_the_confirmed_bar` |
| `errors.spec.ts`: 원천 인증 8050·과거 조회 오류 | 애플리케이션 오류의 이유·복구 버튼·기존 봉 유지 표시 | `kiwoom::error::tests::every_listed_code_has_one_rule_and_the_expected_category`; `kiwoom::rest::tests::designated_terminal_rejection_halts_even_on_a_non_200_status`; `bars::tests::quarterly_initial_and_mid_page_failure_never_seed_or_return_a_partial_quarter` |
| `restore.spec.ts`, `watchlists.spec.ts`, `legend-panels.spec.ts`, `quarter-year.spec.ts`의 서버 재시작 부분 | 저장 요청과 새로고침 이후 설정·목록·도형 복원 | `userdata::tests::watchlists_round_trip_in_order_and_replace_whole`; `userdata::tests::older_or_equal_revisions_never_overwrite`; `drawings::tests::drawings_round_trip_every_field_and_list_by_z_within_one_symbol` |
| `close-while-saving.spec.ts`의 마지막 서버 재시작 | 앞 저장을 붙잡고 탭을 닫은 뒤 같은 시험의 새 브라우저 문맥에서 마지막 편집 복원 | 실제 HTTP·저장 검증은 `userdata`·`user_routes`의 SQLite 시험 |

`admission-recovery`, `completion-controls`, `f3-regression`, `journal-controls`, `journal-regression`, `publication-regression`, `revision-retirement`, `sync-settings-regression`의 로컬 저널·여러 탭·늦은 ACK 검증은 브라우저에 남는다. 자료 준비와 관찰만 메모리 문서 저장소로 바꾸며, 저장 순서·충돌·저널 정리·Undo/Redo의 화면과 localStorage 단언을 유지한다. 실제 서버의 저장·충돌·삭제 계약은 `drawings::tests::drawings_round_trip_and_rejections_over_http`와 `drawings::tests::older_or_equal_revision_never_overwrites_and_delete_is_idempotent`가 담당한다.

스크리너 49개 시험의 이전 이름·현재 이름·계산 검증 소유자는 [스크리너 이동 기록](testing-screener-migration.md)에 있다.

## 재무 화면

`financials.spec.ts`는 지표 추가·숨김·주기 전환·설정 복원, 음수와 0의 실제 렌더링, 실패 안내, 늦은 이전 종목 응답 배제, 원금액·사유 표시와 빈 구간 연결 방지를 유지한다. `financial-history/stop/update/schedule`은 세 viewport의 진행·일시정지·중단·재개·자동 확인 시각을 명시적인 응답으로 표시한다. fixture 자체의 계산값이나 원천 호출 횟수는 브라우저 단언으로 세지 않는다.

| 이전 브라우저 책임 | 실제 서비스 검증 소유자 |
| --- | --- |
| 최초·중간 회사 실패와 가격·다른 회사 사용 | `financials::updates::a_company_failure_before_or_after_success_keeps_other_companies_and_prices_available` |
| 최근 자료 우선·과거 이력 진행·재시작 재개 | `financials::updates::all_companies_recent_reports_precede_history_and_completed_history_is_reused`; `financials::updates::interrupted_recent_http_update_reads_checkpoints_and_resumes_the_original_scope` |
| 일시정지 중 응답 저장·다음 요청 차단·재시작 | `financials::updates::user_pause_saves_the_inflight_response_stops_the_next_request_and_survives_restart` |
| 인증·한도 정지와 확인 한 번으로 재개 | `financials::updates::authentication_stops_the_whole_job_and_requires_successful_explicit_confirmation_after_restart`; `financials::updates::rate_limit_at_first_or_middle_request_persists_and_only_one_confirmation_can_open_it` |
| 첫 자동 수집·같은 날 재시작·다음 날 정정 | `financials::updates::automatic_start_catches_up_once_and_same_day_restart_does_not_create_another_job`; `financials::schedule::daily_confirmation_preempts_history_and_refreshes_old_corrections_before_missing_history` |
| 자동 정지 영속성과 명시적 재개 | `financials::schedule::automatic_dates_and_restart_preserve_user_and_authentication_stops_until_explicit_resume` |
| 공통주·우선주·회사 매핑·분기·연간 계산 | `financials::mapping::preferred_mapping_calculations_and_quarter_year_prices_work_together`; `financial_calculations` |
| 정정 실패 중 기존 값 유지·복구 | `financials::incremental::partial_correction_http_keeps_coherent_values_and_resumes_only_failed_reports_after_restart` |

네이티브 실행 파일 제거, 실제 HTTP·WebSocket 어댑터와 전체 서버 시험의 책임은 [서버 이동 기록](testing-backend-migration.md)에 있다. 실제 DART 진단은 [웹 검사](web-checks.md)의 명시적 `live`만 사용한다.

`close-while-saving.spec.ts` 하나는 시험이 소유한 loopback HTTP endpoint에서 layout GET과 PUT을 받는다. 브라우저가 실제로 닫힌 뒤의 keepalive 요청은 Playwright route가 처리하지 않으므로, 앞선 PUT을 붙잡은 실제 HTTP 경계에서 최신 편집 수신·보존과 새 문맥의 재열기를 검증한다. 이 endpoint는 문서 하나만 저장하며 시장 자료나 원천 프로토콜을 구현하지 않는다.
