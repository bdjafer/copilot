// SPEC-copilot §1 — the `copilot/testing` entry point. DOM-free, like the root entry.
export type { TestCopilot } from './harness.ts'
export { createTestCopilot } from './harness.ts'
export type { ScriptedStep } from './scripted-model.ts'
export { scriptedModel } from './scripted-model.ts'
export type { ConformanceCase } from './store-conformance.ts'
export { runStoreConformance } from './store-conformance.ts'
