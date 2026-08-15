/**
 * The per-model thinking-effort selector: a checkbox popover over the seven
 * pi-ai thinking levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`),
 * matching the escalation vocabulary OpenAI-compatible reasoning dispatch
 * shares across the major vendors. A ticked level stores itself as the wire
 * spelling (`reasoning_effort: "low"` …); `off` stores `null`, which pi-ai
 * reads as "supported, send nothing". Unticking everything removes the field,
 * so a hand-declared model stays non-reasoning.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The seven pi-ai thinking levels, in canonical escalation order. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** One selectable thinking level. */
export type ThinkingLevel = typeof THINKING_LEVELS[number]

/** The ticked levels of one model row, or `undefined` when the profile states nothing. */
export function reasoningLevelsOf(model: Record<string, unknown>): ReadonlySet<string> | undefined {
  const value = model.reasoningEfforts
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return new Set(Object.keys(value))
}

/** The wire-spelling dict a ticked set stores: levels send their own name, `off` sends nothing. */
export function reasoningEffortsOf(ticked: ReadonlySet<string>): Record<string, string | null> {
  const efforts: Record<string, string | null> = {}
  for (const level of THINKING_LEVELS) {
    if (ticked.has(level)) efforts[level] = level === 'off' ? null : level
  }
  return efforts
}

/** Props of {@link ReasoningEffortsField}. */
export interface ReasoningEffortsFieldProps {
  /** The currently ticked levels; `undefined` when the profile states nothing. */
  levels: ReadonlySet<string> | undefined
  /** Replace the row's `reasoningEfforts`; `undefined` removes the field. */
  onChange: (efforts: Record<string, string | null> | undefined) => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
}

/**
 * Render one model row's thinking-effort selector.
 * @param props - the ticked levels, the write callback, and the section copy.
 * @returns the labelled popover trigger with its checkbox menu.
 */
export function ReasoningEffortsField(props: ReasoningEffortsFieldProps): ReactNode {
  const { levels, onChange, t, disabled } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const ticked = levels ?? new Set<string>()

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const toggle = (level: ThinkingLevel): void => {
    const next = new Set(ticked)
    if (!next.delete(level)) next.add(level)
    onChange(next.size === 0 ? undefined : reasoningEffortsOf(next))
  }

  const selectAll = (): void => {
    onChange(reasoningEffortsOf(new Set<string>(THINKING_LEVELS)))
  }

  const clear = (): void => {
    onChange(undefined)
  }

  const summary = ticked.size === 0
    ? t('reasoningNone')
    : t('reasoningCount').replace('{count}', String(ticked.size))

  return (
    <div className={styles['reasoningField']} ref={rootRef}>
      <span className={styles['modelFieldLabel']}>{t('modelReasoning')}</span>
      <button
        type="button"
        className={styles['reasoningTrigger']}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={styles['reasoningSummary']}>{summary}</span>
        <IconChevronDownOutline14 />
      </button>
      {open && (
        <div className={styles['reasoningMenu']} role="listbox" aria-multiselectable="true">
          <div className={styles['reasoningActions']}>
            <button type="button" disabled={disabled} onClick={selectAll}>{t('reasoningAll')}</button>
            <button type="button" disabled={disabled} onClick={clear}>{t('reasoningClear')}</button>
          </div>
          {THINKING_LEVELS.map(level => (
            <label key={level} className={styles['reasoningOption']}>
              <input
                type="checkbox"
                checked={ticked.has(level)}
                disabled={disabled}
                onChange={() => { toggle(level) }}
              />
              <span className={styles['reasoningName']}>{t(`effort.${level}` as keyof typeof en)}</span>
              <span className={styles['reasoningWire']}>{level === 'off' ? t('reasoningOffWire') : level}</span>
            </label>
          ))}
        </div>
      )}
      <span className={styles['reasoningHint']}>{t('reasoningHint')}</span>
    </div>
  )
}
