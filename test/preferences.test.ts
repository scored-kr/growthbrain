import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  approvedHeadlinePreference, decideHeadlinePreference, headlinePreferencePending,
  observeHeadlinePreference, type PreferenceState
} from '../src/preferences.ts'

const first = 'f063aa9a-7194-407e-bcc0-e8cea1beb392'
const second = 'd1ad6c55-1417-406d-b0de-5a64b3cc9eaa'
const query = '상세페이지 제목을 써 줘.'
const fixedPreference = '별도 요청이 없으면 제목은 짧게 씁니다.'

test('only grounded positive feedback on two distinct work projects raises the question', () => {
  let state: PreferenceState | undefined
  for (const text of ['제목이 짧아', '짧은 제목이 좋을까?', '짧은 제목이 좋아 보이지만 싫어', '2안 채택', '아빠가 짧은 제목이 좋대', '짧은 제목이 좋아. https://example.org']) {
    assert.equal(observeHeadlinePreference(state, first, text), undefined)
  }
  assert.equal(observeHeadlinePreference(state, '고객 사연', '짧은 제목이 좋아'), undefined)
  state = observeHeadlinePreference(state, first, '짧은 헤드라인이 좋아서')
  assert.deepEqual(state, {status: 'observed', projectId: first})
  assert.equal(headlinePreferencePending(state), false)
  assert.equal(decideHeadlinePreference(state, 'accepted'), state)
  assert.equal(observeHeadlinePreference(state, first.toUpperCase(), '제목이 짧아서 좋아'), state)
  state = observeHeadlinePreference(state, second, '제목이 짧아서 좋아')
  assert.deepEqual(state, {status: 'pending'})
  assert.equal(headlinePreferencePending(state), true)
  assert.equal(approvedHeadlinePreference(state, query), undefined)
})

test('the first answer settles the question and only the fixed sentence can be shared', () => {
  const accepted = decideHeadlinePreference({status: 'pending'}, 'accepted')
  const declined = decideHeadlinePreference({status: 'pending'}, 'declined')
  assert.equal(approvedHeadlinePreference(accepted, query), fixedPreference)
  assert.equal(approvedHeadlinePreference(accepted, '내 기본 헤드라인 스타일을 알려줘'), fixedPreference)
  assert.equal(approvedHeadlinePreference(declined, query), undefined)
  for (const state of [accepted, declined]) {
    assert.equal(headlinePreferencePending(state), false)
    assert.equal(observeHeadlinePreference(state, first, '짧은 제목이 좋아'), state)
    assert.equal(decideHeadlinePreference(state, 'declined'), state)
    assert.equal(decideHeadlinePreference(state, 'accepted'), state)
  }
})

test('verbatim recall, personal stories and the current user request take precedence', () => {
  for (const text of [
    '최신 확정안 알려줘', '어제 고른 2안의 첫 문장만 바꿔줘', '이번에는 제목을 길게 써줘',
    '제목을 정확히 여섯 단어로 작성해 줘', '제목을 써 줘. 단, 두 문단으로.', '어머니가 한 말을 제목으로 써줘'
  ]) assert.equal(approvedHeadlinePreference({status: 'accepted'}, text), undefined)
})
