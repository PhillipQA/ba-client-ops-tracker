export type TestCaseSourceKind = 'BRD' | 'FSD' | 'User Story' | 'Acceptance Criteria' | 'Change Request' | 'Meeting notes' | 'Supporting document' | 'Chat'
export type TestCaseSource = { id: string; name: string; kind: TestCaseSourceKind; text: string }
export type TestCaseSkill = { id: string; name: string; instructions: string; builtIn?: boolean }
export type CoverageRequirement = { id: string; title: string; sourceIds: string[]; scenarios: string[] }
export type CoverageMap = { requirements: CoverageRequirement[]; gaps: string[]; provider: string; model: string; generatedAt: string }
export type TestCaseRow = {
  id: string
  module: string
  requirementRef: string
  scenario: string
  preconditions: string
  steps: string
  expectedResult: string
  priority: 'Low' | 'Medium' | 'High' | 'Critical'
  type: string
  testData: string
  platform: string
  automationCandidate: 'Yes' | 'No' | 'Review'
  remarks: string
}
export type CoverageFinding = { severity: 'info' | 'warning'; text: string }
export type TestCasePreview = {
  cases: TestCaseRow[]
  coverageReview: {
    summary: string
    coveredRequirements: number
    totalRequirements: number
    findings: CoverageFinding[]
  }
  provider: string
  model: string
  generatedAt: string
}
export const TEST_CASE_SKILLS: TestCaseSkill[] = [
  { id: 'functional', name: 'Functional Testing', builtIn: true, instructions: 'Generate independently executable functional cases for supported normal, alternate, validation, error, and cancellation paths. Keep expected results measurable.' },
  { id: 'uat', name: 'UAT Testing', builtIn: true, instructions: 'Focus on business-user workflows, acceptance criteria, user outcomes, business rules, permissions, and observable pass/fail results suitable for UAT.' },
  { id: 'regression', name: 'Regression Testing', builtIn: true, instructions: 'Identify impacted existing behaviors and regression scenarios around changed functionality without inventing unsupported legacy behavior.' },
  { id: 'negative-edge', name: 'Negative & Edge Cases', builtIn: true, instructions: 'Emphasize invalid inputs, boundaries, missing data, duplicate actions, interruption/retry, permission failures, and ambiguous/error conditions supported by the sources.' },
  { id: 'uiux', name: 'UI / UX Validation', builtIn: true, instructions: 'Cover visible labels, controls, required states, interaction behavior, responsiveness, accessibility-relevant behavior, and exact design requirements only when supported by the sources.' },
  { id: 'api', name: 'API & Integration Testing', builtIn: true, instructions: 'Cover request/response behavior, validation, mapping, authorization, timeout/retry, idempotency, and error handling only when the source documents specify or imply an integration.' },
  { id: 'mobile', name: 'Mobile Testing', builtIn: true, instructions: 'Cover mobile-specific layouts, gestures, orientation, permissions, connectivity changes, and device behavior only when mobile scope is supported by the requirements.' },
  { id: 'e2e', name: 'End-to-End Testing', builtIn: true, instructions: 'Create end-to-end scenarios that trace complete supported business flows across modules or actors, preserving source-defined handoffs and outcomes.' },
]
export const TEST_CASE_COLUMNS: { key: keyof TestCaseRow; label: string }[] = [
  { key: 'id', label: 'TC ID' },
  { key: 'module', label: 'Module' },
  { key: 'requirementRef', label: 'Requirement Reference' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'preconditions', label: 'Preconditions' },
  { key: 'steps', label: 'Steps' },
  { key: 'expectedResult', label: 'Expected Result' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Type' },
  { key: 'testData', label: 'Test Data' },
  { key: 'platform', label: 'Platform' },
  { key: 'automationCandidate', label: 'Automation Candidate' },
  { key: 'remarks', label: 'Remarks' },
]
