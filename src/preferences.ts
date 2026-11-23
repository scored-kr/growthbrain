/** Only an opaque work-project ID is needed to distinguish the first two observations. */
export type PreferenceState =
  | {status: 'observed', projectId: string}
  | {status: 'pending' | 'accepted' | 'declined'}

const projectUuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu
const explicitPreferences = [
  /^(?:짧은|간결한)\s*(?:제목|헤드라인)(?:이|을|으로)?\s*(?:좋아(?:요|서)?|선호(?:해(?:요|서)?|합니다)|원해(?:요|서)?)[.!]?$/u,
  /^(?:제목|헤드라인)(?:이|은)?\s*(?:짧아서|간결해서)\s*(?:좋아(?:요|서)?|마음에\s*들어(?:요|서)?)[.!]?$/u,
  /^(?:제목|헤드라인)(?:은|을)?\s*(?:짧게|간결하게)\s*(?:써\s*줘|해\s*줘)[.!]?$/u
]

/** Call only for feedback on a real option, or the reason for its confirmed adoption. */
export function observeHeadlinePreference(
  state: PreferenceState | undefined, projectId: string, feedback: string
): PreferenceState | undefined {
  if (state && state.status !== 'observed') return state
  if (!projectUuid.test(projectId) || !explicitPreferences.some(rule => rule.test(feedback.trim()))) return state
  const id = projectId.toLowerCase()
  if (!state) return {status: 'observed', projectId: id}
  return state.projectId === id ? state : {status: 'pending'}
}

export function headlinePreferencePending(state: PreferenceState | undefined): boolean {
  return state?.status === 'pending'
}

export function decideHeadlinePreference(
  state: PreferenceState | undefined, decision: 'accepted' | 'declined'
): PreferenceState | undefined {
  return headlinePreferencePending(state) ? {status: decision} : state
}

// An exact request for default style or an unconstrained headline request is safe.
// Copy retrieval, targeted edits and creative constraints keep their own instructions.
const defaultStyleRequest = /^(?:(?:내|나의|우리)\s*)?(?:(?:공통|기본)\s*)?(?:제목|헤드라인)\s*(?:취향|선호(?:도)?|스타일)(?:은|는|을|이)?\s*(?:뭐야|어때|알려\s*줘|보여\s*줘)[?.!]?$/u
const neutralHeadlineRequest = /^(?:(?:이|새)\s*)?(?:상세\s*페이지\s*)?(?:제목|헤드라인)(?:을|만)?\s*(?:써|작성해|만들어|추천해)\s*(?:줘|주세요)[.!]?$/u

export function approvedHeadlinePreference(
  state: PreferenceState | undefined, query: string
): string | undefined {
  if (state?.status !== 'accepted') return
  if (defaultStyleRequest.test(query.trim()) || neutralHeadlineRequest.test(query.trim())) {
    return '별도 요청이 없으면 제목은 짧게 씁니다.'
  }
}
