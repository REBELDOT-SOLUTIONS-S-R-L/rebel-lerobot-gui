import type { Result } from '@shared/types'
import type { LerobotApi } from '../../preload'

/**
 * The bridge the preload script exposes on `window`.
 *
 * Typed with one explicit cast here rather than a global `Window` augmentation,
 * so there is exactly one place that knows the property name and every consumer
 * gets the real type.
 */
export const api = (window as unknown as { lerobotGui: LerobotApi }).lerobotGui

/**
 * Unwrap a Result, throwing on failure.
 *
 * Panels either `await unwrap(...)` inside a try/catch that renders the message,
 * or use `attempt` when a failure is expected and should not interrupt the flow.
 */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const res = await promise
  if (res.ok) return res.value
  const err = new Error(res.error) as Error & { detail?: string }
  if (res.detail) err.detail = res.detail
  throw err
}

export async function attempt<T>(promise: Promise<Result<T>>): Promise<{ value?: T; error?: string }> {
  const res = await promise
  return res.ok ? { value: res.value } : { error: res.error }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
