from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest

import test_dispatch as fixture
from contracts import digest
from github import decision_body
from journal import Journal, read


CLI = Path(__file__).with_name('coordinate.py')


class HarnessTests(unittest.TestCase):
    setUp = fixture.DispatchTests.setUp
    git = fixture.DispatchTests.git
    run_script = fixture.DispatchTests.run_script
    recorded = fixture.DispatchTests.recorded
    launches = fixture.DispatchTests.launches
    release_reservations = fixture.DispatchTests.release_reservations

    def cli(self, *args):
        return subprocess.run([sys.executable, str(CLI), *args, '--state-dir', str(self.state_dir)],
                              capture_output=True, text=True, env=self.env)

    def data(self):
        return read(self.gh_data)

    def save(self, data):
        self.gh_data.write_text(json.dumps(data))

    def source(self):
        result = self.cli('status', '--ticket', '2')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['source']

    def ready(self, ticket=2):
        result = self.cli('ready', '--ticket', str(ticket))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def submit(self, value, publish=False, operation=None, reconcile=False, ok=True):
        path = self.root / ('input-' + str(time.time_ns()) + '.json')
        path.write_text(json.dumps(value))
        args = ['record', '--file', str(path)]
        if publish or reconcile:
            args += ['--reconcile' if reconcile else '--publish', '--operation', operation or 'decision-' + str(time.time_ns())]
        result = self.cli(*args)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result

    def result(self, role='worker', conditions=None, pr=10, outcome='passed', findings=None, resolves=None, extra_pr=None):
        self.release_reservations()
        self.settings = {'receipt': {'taskId': 'task_' + str(time.time_ns()), 'dispatchId': 'ctx_' + str(time.time_ns())}}
        started = self.run_script('start', role=role)
        self.assertEqual(started.returncode, 0, started.stderr)
        op = Journal(self.state_dir).operation('launch-' + str(self.counter))
        launch = read(op / 'launched.json')
        manifest = self.envelope['capabilities']
        keys = ['tool:' + t for t in manifest['tools']] + ['scope:' + s for s in manifest['account_data_scope']]
        claim = {'kind': 'result', 'id': 'result-' + op.name, 'source': launch['assignment']['source'], 'role': role,
            'assignment': {'operation': op.name, 'issued_at': read(op / 'intent.json')['issued_at'],
                           'requested': launch['assignment'], 'launch': launch['launch']},
            'report': 'local report.md; available only on execution host',
            'subjects': [{'pr': pr, 'head': self.head, 'conditions': {c: {'outcome': outcome, 'evidence': 'fixture reproduction.json'} for c in conditions or ['literal']},
                          'findings': findings or [], 'resolves': resolves or []}],
            'capability_observations': {k: {'status': 'available', 'evidence': 'temporary fixture'} for k in keys},
            'provider_execution': {'model': None, 'source': None},
            'procedure': {'skills': [], 'playbooks': [], 'skips': ['synthetic boundary only']},
            'provenance': self.provenance(role + '_claim')}
        if extra_pr:
            claim['subjects'].append(copy.deepcopy(claim['subjects'][0]))
            claim['subjects'][-1]['pr'] = extra_pr
        self.submit(claim)
        return claim

    def provenance(self, kind='coordinator_verdict'):
        return {'class': kind, 'ref': 'synthetic original instruction, not actual user approval',
                'time': '2026-11-10T00:00:00Z', 'scope': 'fixture only', 'omissions': 'no live evidence'}

    def acceptance(self, claim):
        return {'kind': 'accept', 'source': claim['source'], 'summary': 'Inspect fixture claims',
                'claim': claim, 'claim_hash': digest(claim), 'conditions': ['literal'], 'provenance': self.provenance()}

    def decision(self, kind, pr=10, **fields):
        return {'kind': kind, 'source': self.source(), 'summary': 'Synthetic coordinator decision',
            'subjects': [{'pr': pr, 'head': self.head, 'conditions': ['literal']}],
            'provenance': self.provenance('user_instruction' if kind in {'approval', 'exclusion'} else 'coordinator_verdict'), **fields}

    def add_pr(self, number=10, head=None):
        data = self.data()
        data['prs'][str(number)] = {'number': number, 'head': {'sha': head or self.head},
                                    'base': {'repo': {'full_name': 'Soochol/vallythevally'}}, 'state': 'open', 'merged': False}
        self.save(data)

    def accepted_pair(self, pr=10):
        self.add_pr()
        worker = self.result(pr=pr)
        self.submit(self.acceptance(worker), publish=True)
        self.assertEqual(self.ready()['subjects'][0]['stage'], 'ready_for_review')
        reviewer = self.result('reviewer', pr=pr)
        self.submit(self.acceptance(reviewer), publish=True)
        return worker, reviewer

    def test_native_frontier_blockers_phases_and_wrong_identity(self):
        result = self.cli('status', '--feature', '1')
        self.assertTrue(json.loads(result.stdout)['tickets'][0]['frontier'])
        data = self.data()
        blocker = copy.deepcopy(data['issues']['2'])
        blocker.update(number=3, id=300, node_id='ISSUE3')
        data['issues']['3'] = blocker
        data['blockers']['2'] = [3]
        self.save(data)
        self.assertFalse(json.loads(self.cli('status', '--feature', '1').stdout)['tickets'][0]['frontier'])
        data['issues']['2']['labels'].append({'name': 'coord:working'})
        self.save(data)
        self.assertNotEqual(self.cli('status', '--ticket', '2').returncode, 0)
        data['issues']['2']['repository_url'] = 'https://api.github.com/repos/other/other'
        self.save(data)
        self.assertNotEqual(self.run_script('start').returncode, 0)
        self.assertFalse(self.launches())

    def test_contract_revision_not_comment_timestamp_and_selected_propagation(self):
        before = self.source()
        data = self.data()
        data['issues']['2']['updated_at'] = 'later'
        data['comments']['2'] = [{'id': 99, 'body': 'ordinary discussion', 'user': {'id': 5}}]
        self.save(data)
        self.assertEqual(self.source(), before)
        self.assertEqual(self.run_script('start').returncode, 0)
        self.assertIn(self.envelope['acceptance_conditions'][0]['outcome'], self.launches()[0]['body'])
        self.assertIn(before['revision'], self.launches()[0]['body'])
        self.assertIn('Inspect fake Orca received body', self.launches()[0]['body'])

    def test_source_changes_before_dispatch_reject_without_start(self):
        data = self.data()
        data['change_on_read'] = 2
        self.save(data)
        result = self.run_script('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.launches())
        self.assertTrue((self.state_dir / 'operations/launch-1/rejected.json').exists())

    def test_malformed_duplicate_blocks_and_wrong_type_refuse(self):
        for mutation in ('duplicate', 'malformed', 'type', 'duplicate-json'):
            data = self.data()
            if mutation == 'duplicate':
                data['issues']['2']['body'] *= 2
            elif mutation == 'malformed':
                data['issues']['2']['body'] = '<!-- vally-ticket:v1 --> invalid <!-- /vally-ticket -->'
            elif mutation == 'type':
                data['issues']['2']['pull_request'] = {'url': 'PR'}
            else:
                data['issues']['2']['body'] = data['issues']['2']['body'].replace('"goal":', '"goal": "ambiguous", "goal":')
            self.save(data)
            self.assertNotEqual(self.cli('status', '--ticket', '2').returncode, 0)
            data['issues']['2'] = copy.deepcopy(self.gh_state['issues']['2'])
            self.save(data)

    def test_claim_duplicate_conflict_and_no_implicit_verdict(self):
        claim = self.result()
        self.assertTrue(json.loads(self.submit(claim).stdout)['duplicate'])
        changed = copy.deepcopy(claim)
        changed['report'] = 'conflicting report'
        self.submit(changed, ok=False)
        self.assertFalse(self.ready()['subjects'])
        self.assertFalse(any(self.data()['comments'].values()))
        self.assertFalse(list(self.state_dir.rglob('*.sqlite')))

    def test_wrong_assignment_head_condition_and_capability_refuse(self):
        claim = self.result('reviewer')
        for change in ('head', 'task', 'condition', 'capability'):
            bad = copy.deepcopy(claim)
            bad['id'] += change
            if change == 'head': bad['subjects'][0]['head'] = '1' * 40
            if change == 'task': bad['assignment']['launch']['taskId'] = 'wrong'
            if change == 'condition': bad['subjects'][0]['conditions'] = {'other': {'outcome': 'passed', 'evidence': 'x'}}
            if change == 'capability': bad['capability_observations'] = {}
            self.submit(bad, ok=False)

    def test_lost_comment_response_reconciles_without_repost(self):
        self.add_pr()
        claim = self.result()
        payload = self.acceptance(claim)
        data = self.data(); data['lose_comment_response'] = True; self.save(data)
        self.submit(payload, publish=True, operation='lost-ack', ok=False)
        self.assertEqual(len(self.data()['comments']['2']), 1)
        self.assertFalse((self.state_dir / 'operations/lost-ack/ack.json').exists())
        self.submit(payload, publish=True, operation='lost-ack', ok=False)
        self.submit(payload, reconcile=True, operation='lost-ack')
        self.assertEqual(len(self.data()['comments']['2']), 1)
        self.assertTrue((self.state_dir / 'operations/lost-ack/ack.json').exists())
        altered = copy.deepcopy(payload); altered['summary'] = 'different'
        self.submit(altered, reconcile=True, operation='lost-ack', ok=False)

    def test_partial_phase_error_is_not_completion_and_unrelated_labels_survive(self):
        payload = self.decision('phase', effect={'action': 'phase', 'phase': 'coord:working'})
        data = self.data(); data['fail_delete'] = True; self.save(data)
        self.submit(payload, publish=True, operation='phase-partial', ok=False)
        labels = {label['name'] for label in self.data()['issues']['2']['labels']}
        self.assertIn('needs-triage', labels)
        self.assertTrue({'coord:ready', 'coord:working'} <= labels)
        self.assertFalse((self.state_dir / 'operations/phase-partial/ack.json').exists())
        self.submit(payload, reconcile=True, operation='phase-partial', ok=False)
        self.assertEqual(len(self.data()['comments']['2']), 1)

    def test_phase_ack_requires_actual_state_readback(self):
        payload = self.decision('phase', effect={'action': 'phase', 'phase': 'coord:working'})
        self.submit(payload, publish=True, operation='phase-ok')
        labels = {x['name'] for x in self.data()['issues']['2']['labels']}
        self.assertEqual(labels, {'coord:ticket', 'coord:working', 'needs-triage'})
        self.assertTrue((self.state_dir / 'operations/phase-ok/ack.json').exists())

    def test_source_changes_during_publication_refuse_no_false_ack(self):
        payload = self.decision('phase', effect={'action': 'phase', 'phase': 'coord:working'})
        data = self.data(); data['change_on_read'] = data['issue_reads'] + 2; self.save(data)
        self.submit(payload, publish=True, operation='changed', ok=False)
        self.assertFalse(any(self.data()['comments'].values()))

    def test_decision_markers_hash_author_duplicate_and_scope_are_checked(self):
        for variant in ('hash', 'author', 'duplicate'):
            data = self.data()
            payload = self.decision('approval', approval_kind='design', decision='approved')
            body = decision_body('marker', payload)
            comment = {'id': 100, 'body': body, 'user': {'id': 150162001}}
            if variant == 'hash': comment['body'] = body.replace('"approved"', '"revoked"')
            if variant == 'author': comment['user']['id'] = 9
            data['comments']['2'] = [comment] * (2 if variant == 'duplicate' else 1)
            self.save(data)
            self.assertNotEqual(self.cli('ready', '--ticket', '2').returncode, 0)
            data['comments']['2'] = []; self.save(data)

    def test_old_head_review_and_wrong_kind_approval_do_not_promote(self):
        self.accepted_pair()
        final = self.decision('final_check', outcome='passed', report='local final.log')
        self.submit(final, publish=True)
        self.assertEqual(self.ready()['subjects'][0]['stage'], 'waiting_for_merge_approval')
        self.assertEqual(self.ready()['stage'], 'waiting_for_merge_approval')
        self.submit(self.decision('approval', approval_kind='account', decision='approved'), publish=True)
        self.assertFalse(self.ready()['ticket_close_ready'])
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        self.assertTrue(self.ready()['ticket_close_ready'])
        self.add_pr(head='2' * 40)
        self.assertFalse(self.ready()['ticket_close_ready'])
        self.submit(final, publish=True, ok=False)

    def test_proven_findings_block_and_fresh_current_review_resolves(self):
        self.add_pr()
        self.submit(self.acceptance(self.result()), publish=True)
        finding = {'id': 'race', 'condition': 'literal', 'summary': 'Reproduced race', 'reproduction': 'local race.py'}
        old = self.result('reviewer', findings=[finding])
        self.submit(self.acceptance(old), publish=True)
        self.assertEqual(self.ready()['stage'], 'blocked')
        fresh = self.result('reviewer', resolves=['race'])
        self.submit(self.acceptance(fresh), publish=True)
        self.assertFalse(self.ready()['open_findings'])
        self.submit(self.acceptance(old), publish=True, ok=False)
        self.assertFalse(self.ready()['open_findings'])

    def test_approved_exclusion_stays_unverified(self):
        self.add_pr()
        self.submit(self.acceptance(self.result(outcome='unverified')), publish=True)
        self.submit(self.acceptance(self.result('reviewer', outcome='unverified')), publish=True)
        self.submit(self.decision('exclusion', reason='Read-only scope excludes product check', decision='approved'), publish=True)
        result = self.ready()['subjects'][0]
        self.assertEqual(result['unverified_exclusions'], ['literal'])
        self.assertFalse(result['review_passed'])
        self.assertTrue(result['review_requirement_satisfied'])

    def test_many_to_many_pr_ticket_links_and_selected_scope_cannot_close_whole_ticket(self):
        self.add_pr(10); self.add_pr(11)
        claim = self.result(extra_pr=11)
        self.submit(self.acceptance(claim), publish=True)
        self.assertEqual({s['pr'] for s in self.ready()['subjects']}, {10, 11})
        payload = self.decision('close', effect={'action': 'close'})
        self.submit(payload, publish=True, operation='premature-close', ok=False)
        self.assertEqual(self.data()['issues']['2']['state'], 'open')
        data = self.data()
        data['issues']['3'] = copy.deepcopy(data['issues']['2']); data['issues']['3'].update(id=300, node_id='ISSUE3', number=3)
        data['parents']['3'] = 1; data['children']['1'].append(3); data['blockers']['3'] = []
        self.save(data)
        self.request['ticket'] = 3; self.spec.write_text(json.dumps(self.request))
        shared = self.result(); self.submit(self.acceptance(shared), publish=True)
        self.assertEqual(self.ready(3)['subjects'][0]['pr'], 10)
        self.assertEqual({s['pr'] for s in self.ready()['subjects']}, {10, 11})

    def test_close_ack_requires_whole_ticket_current_delivery_and_never_closes_feature(self):
        self.accepted_pair()
        self.submit(self.decision('final_check', outcome='passed', report='local final.log'), publish=True)
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        self.submit(self.decision('close', effect={'action': 'close'}), publish=True, operation='close-ok')
        self.assertEqual(self.ready()['stage'], 'closed_completed')
        self.assertEqual(self.data()['issues']['1']['state'], 'open')

    def test_selected_condition_success_cannot_close_complete_source_ticket(self):
        self.envelope['acceptance_conditions'].append({'id': 'other', 'outcome': 'A separate deliverable is verified'})
        self.envelope['verification_plan'].append({'condition': 'other', 'method': 'Inspect the separate artifact', 'evidence': 'other.md'})
        data = self.data()
        data['issues']['2']['body'] = '<!-- vally-ticket:v1 -->\n```json\n' + json.dumps(self.envelope) + '\n```\n<!-- /vally-ticket -->'
        self.save(data)
        self.request['revision'] = digest(self.envelope); self.spec.write_text(json.dumps(self.request))
        self.accepted_pair()
        self.submit(self.decision('final_check', outcome='passed', report='local final.log'), publish=True)
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        self.assertEqual(self.ready()['missing_ticket_conditions'], ['other'])
        self.assertEqual(self.ready()['subjects'][0]['stage'], 'merge_ready')
        self.submit(self.decision('close', effect={'action': 'close'}), publish=True, ok=False)
        self.assertEqual(self.data()['issues']['2']['state'], 'open')

    def test_lost_close_response_reconciles_actual_closed_state_without_second_patch(self):
        self.accepted_pair()
        self.submit(self.decision('final_check', outcome='passed', report='local final.log'), publish=True)
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        payload = self.decision('close', effect={'action': 'close'})
        data = self.data(); data['lose_close_response'] = True; self.save(data)
        self.submit(payload, publish=True, operation='close-lost', ok=False)
        self.assertEqual(self.data()['issues']['2']['state'], 'closed')
        self.assertFalse((self.state_dir / 'operations/close-lost/ack.json').exists())
        self.submit(payload, reconcile=True, operation='close-lost')
        calls = [json.loads(line) for line in self.gh_calls.read_text().splitlines()]
        self.assertEqual(sum(call['method'] == 'PATCH' for call in calls), 1)

    def test_changed_semantic_source_and_wrong_pr_approval_stay_historical(self):
        self.accepted_pair()
        self.add_pr(11)
        self.submit(self.decision('final_check', outcome='passed', report='final.log'), publish=True)
        self.submit(self.decision('approval', pr=11, approval_kind='merge', decision='approved'), publish=True)
        self.assertFalse(self.ready()['ticket_close_ready'])
        old = self.decision('approval', approval_kind='merge', decision='approved')
        data = self.data()
        data['issues']['2']['body'] = data['issues']['2']['body'].replace('Preserve literal shell text', 'New task requires different evidence')
        self.save(data)
        self.assertFalse(self.ready()['subjects'])
        self.submit(old, publish=True, ok=False)

    def test_runtime_identity_unavailable_does_not_become_verified_completion(self):
        self.accepted_pair()
        self.submit(self.decision('final_check', outcome='passed', report='final.log'), publish=True)
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        runtime = self.root / 'runtime.json'
        values = read(runtime)
        for assignment in values.values(): assignment['taskId'] = 'different-task'
        runtime.write_text(json.dumps(values))
        self.assertFalse(self.ready()['ticket_close_ready'])
        self.assertTrue(any(not item['settled_identity_verified'] for item in self.ready()['runtime_observations']))

    def test_no_pr_delivery_is_source_specific_and_still_requires_review_final_approval(self):
        self.envelope['delivery'] = {'kind': 'no_repository_change', 'reason': 'Read-only scratch task changes no repository'}
        data = self.data()
        data['issues']['2']['body'] = '<!-- vally-ticket:v1 -->\n```json\n' + json.dumps(self.envelope) + '\n```\n<!-- /vally-ticket -->'
        self.save(data)
        self.request['revision'] = digest(self.envelope); self.spec.write_text(json.dumps(self.request))
        self.accepted_pair(pr=None)
        self.assertFalse(self.ready()['ticket_close_ready'])
        self.submit(self.decision('final_check', pr=None, outcome='passed', report='local final.log'), publish=True)
        self.assertFalse(self.ready()['ticket_close_ready'])
        self.submit(self.decision('approval', pr=None, approval_kind='close', decision='approved'), publish=True)
        self.assertTrue(self.ready()['ticket_close_ready'])
        self.assertEqual(self.ready()['subjects'][0]['stage'], 'ticket_subject_ready')

    def test_new_execution_invalidates_earlier_attempt_readiness_at_same_head(self):
        self.accepted_pair()
        self.assertTrue(self.ready()['subjects'][0]['review_passed'])
        self.result('worker')
        result = self.ready()
        self.assertFalse(result['subjects'][0]['review_passed'])
        self.assertFalse(result['ticket_close_ready'])

    def test_reopened_native_blocker_prevents_ticket_completion(self):
        self.accepted_pair()
        self.submit(self.decision('final_check', outcome='passed', report='final.log'), publish=True)
        self.submit(self.decision('approval', approval_kind='merge', decision='approved'), publish=True)
        self.assertTrue(self.ready()['ticket_close_ready'])
        data = self.data()
        data['issues']['3'] = copy.deepcopy(data['issues']['2']); data['issues']['3'].update(id=300, number=3, node_id='ISSUE3')
        data['blockers']['2'] = [3]; self.save(data)
        self.assertEqual(self.ready()['stage'], 'blocked')
        self.assertFalse(self.ready()['ticket_close_ready'])

    def test_remote_child_routing_is_explicitly_unsupported_without_orca_call(self):
        self.env['ORCA_ENVIRONMENT'] = 'synthetic-remote'
        self.assertNotEqual(self.new_start().returncode, 0)
        self.assertFalse(self.recorded())

    def test_process_duplicate_dispatch_and_visibility_gap_no_second_launch(self):
        self.settings = {'delay_start': 0.3}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_script('start'), range(2)))
        self.assertEqual(sorted(r.returncode for r in results), [0, 2])
        self.assertEqual(len(self.launches()), 1)
        self.assertNotEqual(self.run_script('start').returncode, 0)
        self.assertEqual(len(self.launches()), 1)

    def new_start(self, name='child-task'):
        return self.run_script('start', role='worker', placement=False, head=False,
            extra=('--new-worktree', name, '--repo', str(self.repo), '--setup', 'skip'))

    def test_child_creation_registered_identity_actual_parent_and_existing_path_lock(self):
        result = self.new_start()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = self.launches()[0]['args']
        self.assertIn('new-child', args); self.assertNotIn('--repo', args)
        self.assertEqual(args[args.index('--setup') + 1], 'skip')
        receipt = read(self.state_dir / 'operations/launch-1/launched.json')
        self.assertEqual(receipt['launch']['placement_observation']['parentWorktreeId'], 'repo::' + str(self.repo))
        self.worktree = self.root / 'child-task'
        self.assertNotEqual(self.run_script('start').returncode, 0)
        self.assertEqual(len(self.launches()), 1)

    def test_wrong_caller_parent_and_uncertain_launch_never_retry(self):
        self.settings = {'caller': str(self.worktree)}
        self.assertNotEqual(self.new_start().returncode, 0)
        self.assertFalse(self.launches())
        self.settings = {'observed_parent': 'wrong'}
        self.assertNotEqual(self.new_start().returncode, 0)
        self.assertNotEqual(self.new_start().returncode, 0)
        self.assertEqual(len(self.launches()), 1)

    def test_new_path_before_receipt_is_protected(self):
        self.settings = {'delay_after_creation': 0.7}
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.new_start)
            child = self.root / 'child-task'; deadline = time.monotonic() + 5
            while not child.exists() and time.monotonic() < deadline: time.sleep(0.01)
            self.assertTrue(child.exists())
            self.worktree = child
            self.assertNotEqual(self.run_script('start').returncode, 0)
            self.assertEqual(first.result().returncode, 0)
        self.assertEqual(len(self.launches()), 1)

    def test_immutable_launch_replay_unknown_and_recovery_proof(self):
        self.settings = {'malformed_start': True}
        self.assertNotEqual(self.run_script('start').returncode, 0)
        self.assertNotEqual(self.run_script('start').returncode, 0)
        self.assertEqual(len(self.launches()), 1)
        with self.assertRaises(Exception):
            Journal(self.state_dir).recover('launch-1', {'proof': 'elapsed', 'runtime_evidence': 'unverifiable'})
        self.assertNotEqual(self.run_script('start').returncode, 0)

    def test_paginated_comments_and_relations_are_fully_read(self):
        data = self.data()
        data['comments']['2'] = [{'id': n, 'body': 'discussion', 'user': {'id': 5}} for n in range(101)]
        self.save(data)
        self.source()
        calls = [json.loads(s) for s in self.gh_calls.read_text().splitlines()]
        self.assertTrue(any('/comments?per_page=100&page=2' in c['endpoint'] for c in calls))
