import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
import threading
import unittest
from unittest.mock import patch

from contracts import Refused, digest
from evidence import validate_decision
from github import END, PREFIX, START, GitHub, decision_body, publish
from journal import Journal
import test_harness as fixture


def two_conditions(test):
    test.envelope['acceptance_conditions'].append({'id': 'other', 'outcome': 'Other behavior passes'})
    test.envelope['verification_plan'].append({'condition': 'other', 'method': 'Inspect other behavior', 'evidence': 'other.log'})
    data = test.data()
    data['issues']['2']['body'] = START + '\n```json\n' + json.dumps(test.envelope) + '\n```\n' + END
    test.save(data)
    test.request.update(revision=digest(test.envelope), conditions=['literal', 'other'])
    test.spec.write_text(json.dumps(test.request))


def accept(test, claim, conditions):
    value = test.acceptance(claim)
    value['conditions'] = conditions
    return value


def scoped(test, kind, conditions, **fields):
    value = test.decision(kind, **fields)
    value['subjects'][0]['conditions'] = conditions
    return value


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.t = fixture.HarnessTests()
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)

    def test_noop_phase_source_drift_keeps_only_comment_ack(self):
        t = self.t
        payload = t.decision('phase', effect={'action': 'phase', 'phase': 'coord:ready'})
        data = t.data()
        data['change_on_read'] = data['issue_reads'] + 4
        t.save(data)
        t.submit(payload, publish=True, operation='stale-phase-ack', ok=False)
        op = t.state_dir / 'operations/stale-phase-ack'
        self.assertTrue((op / 'comment-ack.json').exists())
        self.assertFalse((op / 'ack.json').exists())
        self.assertFalse((op / 'effect-request.json').exists())
        self.assertNotEqual(t.source()['revision'], payload['source']['revision'])

    def test_reconcile_noop_rechecks_source_after_remote_comment(self):
        t = self.t
        payload = t.decision('phase', effect={'action': 'phase', 'phase': 'coord:ready'})
        data = t.data(); data['lose_comment_response'] = True; t.save(data)
        t.submit(payload, publish=True, operation='lost-noop', ok=False)
        data = t.data(); data['change_on_read'] = data['issue_reads'] + 2; t.save(data)
        t.submit(payload, reconcile=True, operation='lost-noop', ok=False)
        self.assertTrue((t.state_dir / 'operations/lost-noop/comment-ack.json').exists())
        self.assertFalse((t.state_dir / 'operations/lost-noop/ack.json').exists())
        self.assertEqual(len(t.data()['comments']['2']), 1)

    def test_comment_only_final_ack_rechecks_semantic_source(self):
        t = self.t
        payload = t.decision('phase')
        data = t.data(); data['change_on_read'] = data['issue_reads'] + 4; t.save(data)
        t.submit(payload, publish=True, operation='stale-comment', ok=False)
        self.assertTrue((t.state_dir / 'operations/stale-comment/comment-ack.json').exists())
        self.assertFalse((t.state_dir / 'operations/stale-comment/ack.json').exists())

    def test_effect_ack_rechecks_native_relations_on_noop_and_readback(self):
        t = self.t
        t.add_pr()
        for desired in ('coord:ready', 'coord:working'):
            with self.subTest(phase=desired):
                payload = t.decision('phase', effect={'action': 'phase', 'phase': desired})
                class ChangedRelations(GitHub):
                    changed = False

                    def api(self, endpoint, method='GET', payload=None):
                        response = super().api(endpoint, method, payload)
                        if method == 'POST' and endpoint.endswith('/comments' if desired == 'coord:ready' else '/labels'):
                            self.changed = True
                        return response

                    def ticket(self, number):
                        snapshot = super().ticket(number)
                        if self.changed:
                            snapshot['parent'] = {'id': 900, 'node_id': 'OTHER', 'number': 9}
                        return snapshot

                operation = 'relations-' + desired.split(':')[1]
                with patch.dict(os.environ, t.env), self.assertRaises(Refused):
                    publish(ChangedRelations(), Journal(t.state_dir), operation, payload)
                self.assertTrue((t.state_dir / 'operations' / operation / 'comment-ack.json').exists())
                self.assertFalse((t.state_dir / 'operations' / operation / 'ack.json').exists())

    def test_timestamp_discussion_and_intended_phase_transition_are_valid(self):
        t = self.t
        t.add_pr()
        payload = t.decision('phase', effect={'action': 'phase', 'phase': 'coord:working'})
        class TimestampOnly(GitHub):
            def api(self, endpoint, method='GET', payload=None):
                response = super().api(endpoint, method, payload)
                if method == 'POST' and endpoint.endswith('/comments'):
                    data = t.data()
                    data['issues']['2']['updated_at'] = 'later'
                    data['comments']['2'].append({'id': 900, 'body': 'Discussion only', 'user': {'id': 5}})
                    t.save(data)
                return response
        with patch.dict(os.environ, t.env):
            outcome = publish(TimestampOnly(), Journal(t.state_dir), 'valid-transition', payload)
        self.assertTrue(outcome['acknowledged'])
        self.assertEqual(t.source(), payload['source'])
        self.assertEqual({x['name'] for x in t.data()['issues']['2']['labels']}, {'coord:ticket', 'coord:working', 'needs-triage'})

    def test_close_noop_rechecks_relations_after_readiness_observation(self):
        t = self.t
        t.accepted_pair()
        t.submit(t.decision('final_check', outcome='passed', report='final.log'), publish=True)
        t.submit(t.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        t.submit(t.decision('close', effect={'action': 'close'}), publish=True)
        payload = t.decision('close', effect={'action': 'close'})
        class ChangedRelations(GitHub):
            reads = 0

            def ticket(self, number):
                snapshot = super().ticket(number)
                self.reads += 1
                if self.reads >= 5:
                    snapshot['parent'] = {'id': 900, 'node_id': 'OTHER', 'number': 9}
                return snapshot
        with patch.dict(os.environ, t.env), self.assertRaises(Refused):
            publish(ChangedRelations(), Journal(t.state_dir), 'close-noop-drift', payload)
        self.assertTrue((t.state_dir / 'operations/close-noop-drift/comment-ack.json').exists())
        self.assertFalse((t.state_dir / 'operations/close-noop-drift/ack.json').exists())

    def test_reversed_or_incomplete_contract_refuses_before_worker_start(self):
        t = self.t
        fence = '\n```json\n' + json.dumps(t.envelope) + '\n```'
        bodies = [END + '\n' + START + fence, START + fence, START + '\n```json\n' + json.dumps(t.envelope) + '\n' + END,
                  START + '\n' + END + fence, START + '\n```json\n' + json.dumps(t.envelope) + '\n``` trailing\n' + END]
        for body in bodies:
            with self.subTest(body=body[:50]):
                data = t.data(); data['issues']['2']['body'] = body; t.save(data)
                self.assertNotEqual(t.cli('status', '--ticket', '2').returncode, 0)
                self.assertNotEqual(t.run_script('start', role='worker').returncode, 0)
                self.assertFalse(t.launches())
        data = t.data(); data['issues']['2']['body'] = 'Outside discussion\n' + START + fence + '\n' + END + '\nOutside discussion'; t.save(data)
        self.assertEqual(t.run_script('start', role='worker').returncode, 0)
        self.assertEqual(len(t.launches()), 1)

    def native_adapter(self, rows):
        data = self.t.data()
        class Adapter(GitHub):
            def api(self, endpoint, method='GET', payload=None):
                if '/sub_issues?' in endpoint:
                    page = int(endpoint.rsplit('page=', 1)[1])
                    return copy.deepcopy(rows[(page - 1) * 100:page * 100])
                if endpoint == f'{PREFIX}/issues/2/dependencies/blocked_by?per_page=100&page=1':
                    return []
                if endpoint == f'{PREFIX}/issues/2/parent':
                    return copy.deepcopy(data['issues']['1'])
                if endpoint in (f'{PREFIX}/issues/1', f'{PREFIX}/issues/2'):
                    return copy.deepcopy(data['issues'][endpoint.rsplit('/', 1)[1]])
                raise AssertionError(endpoint)
        return Adapter()

    def test_foreign_native_child_never_aliases_local_number(self):
        local = self.t.data()['issues']['2']
        foreign = copy.deepcopy(local)
        foreign.update(id=999, node_id='FOREIGN_ISSUE', repository_url='https://api.github.com/repos/other/project')
        with self.assertRaises(Refused):
            self.native_adapter([local, foreign]).feature(1)

    def test_native_child_identity_kind_and_duplicates_refuse(self):
        local = self.t.data()['issues']['2']
        for fields in ({'id': 999}, {'node_id': 'WRONG'}, {'number': True}, {'id': True},
                       {'pull_request': {'url': 'PR'}}, {'labels': [{'name': 'coord:feature'}]}):
            with self.subTest(fields=fields), self.assertRaises(Refused):
                self.native_adapter([dict(local, **fields)]).feature(1)
        with self.assertRaises(Refused):
            self.native_adapter([local, local]).feature(1)

    def test_official_native_rows_and_complete_pagination_remain_supported(self):
        local = self.t.data()['issues']['2']
        local.update(url=f'https://api.github.com/{PREFIX}/issues/2', html_url='https://github.com/Soochol/vallythevally/issues/2')
        self.assertTrue(self.native_adapter([local]).feature(1)['tickets'][0]['frontier'])
        rows = [dict(local, number=n + 10, id=n + 1000, node_id='CHILD' + str(n)) for n in range(100)] + [local]
        adapter = self.native_adapter(rows)
        self.assertEqual(len(adapter.pages(f'{PREFIX}/issues/1/sub_issues')), 101)
        self.assertEqual(adapter.ticket(2)['source']['id'], 200)

    def test_single_journal_delayed_old_acceptance_does_not_resurrect_resolution(self):
        t = self.t
        t.add_pr()
        t.submit(t.acceptance(t.result()), publish=True)
        finding = {'id': 'race', 'condition': 'literal', 'summary': 'Prior real report proved race', 'reproduction': 'fixture race.py'}
        old = t.result('reviewer', findings=[finding])
        reached_post, release_post = threading.Event(), threading.Event()
        class DelayedGitHub(GitHub):
            def api(self, endpoint, method='GET', payload=None):
                if method == 'POST' and endpoint.endswith('/comments'):
                    reached_post.set()
                    if not release_post.wait(30):
                        raise RuntimeError('Delayed acceptance was not released')
                return super().api(endpoint, method, payload)
        with patch.dict(os.environ, t.env), ThreadPoolExecutor(max_workers=1) as pool:
            late = pool.submit(publish, DelayedGitHub(), Journal(t.state_dir), 'delayed-old-review', t.acceptance(old))
            self.assertTrue(reached_post.wait(10))
            try:
                fresh = t.result('reviewer', resolves=['race'])
                t.submit(t.acceptance(fresh), publish=True)
            finally:
                release_post.set()
            self.assertTrue(late.result(timeout=10)['acknowledged'])
        self.assertEqual(t.ready()['open_findings'], [])
        newer = t.result('reviewer', findings=[finding])
        t.submit(t.acceptance(newer), publish=True)
        self.assertEqual([f['id'] for f in t.ready()['open_findings']], ['race'])

    def remote_acceptances(self, claims):
        t = self.t
        data = t.data()
        data['comments']['2'] = [{'id': 100 + n, 'body': decision_body('review-' + str(n), accept(t, claim, conditions)),
                                  'user': {'id': 150162001}} for n, (claim, conditions) in enumerate(claims)]
        t.save(data)

    def review_claim(self, claim, identity, issued, pr=10, condition='literal', resolves=False):
        value = copy.deepcopy(claim)
        value['id'] = 'result:' + identity
        value['assignment']['launch']['dispatchId'] = identity
        value['assignment']['issued_at'] = issued
        value['subjects'][0]['pr'] = pr
        value['subjects'][0]['conditions'] = {condition: {'outcome': 'passed', 'evidence': 'fixture check'}}
        value['subjects'][0]['findings'] = [] if resolves else [{'id': 'race', 'condition': condition, 'summary': identity, 'reproduction': 'fixture race.py'}]
        value['subjects'][0]['resolves'] = ['race'] if resolves else []
        value['assignment']['requested']['conditions'] = [condition]
        return value

    def test_finding_resolution_condition_pr_time_and_acceptance_scopes(self):
        t = self.t
        two_conditions(t); t.add_pr(10); t.add_pr(11)
        template = t.result('reviewer', conditions=['literal', 'other'])
        old = self.review_claim(template, 'old', '2026-11-10T04:00:00+00:00')
        resolution = self.review_claim(template, 'resolve', '2026-11-10T04:00:01+00:00', resolves=True)
        other_condition = self.review_claim(template, 'condition', '2026-11-10T04:00:00+00:00', condition='other')
        other_pr = self.review_claim(template, 'pr', '2026-11-10T04:00:00+00:00', pr=11)
        self.remote_acceptances([(resolution, ['literal']), (other_condition, ['other']), (other_pr, ['literal']), (old, ['literal'])])
        self.assertEqual({(f['pr'], f['condition']) for f in t.ready()['open_findings']}, {(10, 'other'), (11, 'literal')})
        for variant in ('unaccepted', 'stale-head', 'stale-source', 'equal-time', 'equal-offset-time', 'older-offset-time'):
            with self.subTest(variant=variant):
                resolve = copy.deepcopy(resolution)
                accepted = ['literal']
                if variant == 'unaccepted':
                    resolve['subjects'][0]['conditions']['other'] = {'outcome': 'passed', 'evidence': 'other check'}
                    resolve['assignment']['requested']['conditions'].append('other')
                    accepted = ['other']
                if variant == 'stale-head':
                    resolve['subjects'][0]['head'] = '2' * 40
                    resolve['assignment']['requested']['head'] = '2' * 40
                if variant == 'stale-source':
                    resolve['source']['revision'] = 'a' * 64
                if variant == 'equal-time': resolve['assignment']['issued_at'] = old['assignment']['issued_at']
                if variant == 'equal-offset-time': resolve['assignment']['issued_at'] = '2026-11-10T13:00:00+09:00'
                if variant == 'older-offset-time': resolve['assignment']['issued_at'] = '2026-11-10T13:00:00.999999+10:00'
                self.remote_acceptances([(old, ['literal']), (resolve, accepted)])
                self.assertEqual([f['id'] for f in t.ready()['open_findings']], ['race'])

    def test_assignment_order_requires_timezone_aware_valid_timestamps(self):
        t = self.t
        t.add_pr()
        for issued in ('later', '2026-11-10', '2026-11-10T04:00:00', '2026-99-10T04:00:00Z'):
            with self.subTest(issued=issued):
                claim = t.result('reviewer', record=False)
                claim['assignment']['issued_at'] = issued
                t.submit(claim, ok=False)
                self.remote_acceptances([(claim, ['literal'])])
                self.assertNotEqual(t.cli('ready', '--ticket', '2').returncode, 0)

    def accepted_two_conditions(self):
        t = self.t
        two_conditions(t); t.add_pr()
        for role in ('worker', 'reviewer'):
            claim = t.result(role, conditions=['literal', 'other'])
            t.submit(accept(t, claim, ['literal', 'other']), publish=True)
        t.submit(scoped(t, 'approval', ['literal', 'other'], approval_kind='merge', decision='approved'), publish=True)

    def test_split_final_scopes_compose_and_later_same_scope_failure_invalidates(self):
        t = self.t
        self.accepted_two_conditions()
        for condition in ('literal', 'other'):
            t.submit(scoped(t, 'final_check', [condition], outcome='passed', report=condition + '.log'), publish=True)
        self.assertTrue(t.ready()['ticket_close_ready'])
        for outcome in ('failed', 'unverified'):
            t.submit(scoped(t, 'final_check', ['literal'], outcome=outcome, report=outcome + '.log'), publish=True)
            self.assertFalse(t.ready()['subjects'][0]['final_check_passed'])
            self.assertFalse(t.ready()['ticket_close_ready'])
            t.submit(scoped(t, 'final_check', ['other'], outcome='passed', report='unrelated.log'), publish=True)
            self.assertFalse(t.ready()['ticket_close_ready'])
            t.submit(scoped(t, 'final_check', ['literal'], outcome='passed', report='fixed.log'), publish=True)
            self.assertTrue(t.ready()['ticket_close_ready'])

    def test_final_scope_uses_its_own_acceptance_chronology(self):
        t = self.t
        self.accepted_two_conditions()
        t.submit(scoped(t, 'final_check', ['literal'], outcome='passed', report='literal.log'), publish=True)
        t.request['conditions'] = ['other']; t.spec.write_text(json.dumps(t.request))
        for role in ('worker', 'reviewer'):
            claim = t.result(role, conditions=['other'])
            t.submit(accept(t, claim, ['other']), publish=True)
        t.submit(scoped(t, 'final_check', ['other'], outcome='passed', report='other.log'), publish=True)
        self.assertTrue(t.ready()['ticket_close_ready'])
        t.submit(accept(t, claim, ['other']), publish=True)
        self.assertFalse(t.ready()['ticket_close_ready'])
        t.submit(scoped(t, 'final_check', ['literal'], outcome='passed', report='unrelated.log'), publish=True)
        self.assertFalse(t.ready()['ticket_close_ready'])
        t.submit(scoped(t, 'final_check', ['other'], outcome='passed', report='after-reaccept.log'), publish=True)
        self.assertTrue(t.ready()['ticket_close_ready'])

    def split_claim(self):
        t = self.t
        two_conditions(t); t.add_pr(10); t.add_pr(11)
        claim = t.result(conditions=['literal', 'other'], record=False)
        other = copy.deepcopy(claim['subjects'][0])
        other['pr'] = 11
        other['conditions'] = {'other': other['conditions']['other']}
        claim['subjects'][0]['conditions'].pop('other')
        claim['subjects'].append(other)
        return claim

    def test_accept_current_selected_condition_with_unselected_stale_pr(self):
        t = self.t
        claim = self.split_claim()
        t.submit(claim)
        operation = Journal(t.state_dir).operation(claim['assignment']['operation'])
        before = (operation / 'result.json').read_bytes()
        t.add_pr(11, head='2' * 40)
        t.submit(t.acceptance(claim), publish=True)
        self.assertEqual((operation / 'result.json').read_bytes(), before)
        ready = t.ready()
        self.assertEqual([(s['pr'], s['conditions']) for s in ready['subjects']], [(10, ['literal'])])
        self.assertEqual(ready['missing_ticket_conditions'], ['other'])
        self.assertFalse(ready['ticket_close_ready'])
        t.submit(accept(t, claim, ['other']), publish=True, ok=False)
        t.submit(accept(t, claim, ['literal', 'other']), publish=True, ok=False)

    def test_unselected_claims_still_validate_structurally_and_against_source(self):
        t = self.t
        claim = self.split_claim()
        t.submit(claim)
        t.add_pr(11, head='2' * 40)
        malformed = copy.deepcopy(claim)
        malformed['subjects'][1]['conditions']['other']['outcome'] = 'invented'
        t.submit(accept(t, malformed, ['literal']), publish=True, ok=False)
        unknown = t.result(conditions=['literal', 'other'], record=False)
        unknown['subjects'][0]['conditions']['unknown'] = unknown['subjects'][0]['conditions'].pop('other')
        unknown['assignment']['requested']['conditions'] = ['literal', 'unknown']
        with patch.dict(os.environ, t.env), self.assertRaisesRegex(Refused, 'absent from source'):
            validate_decision(accept(t, unknown, ['literal']), github=GitHub())
