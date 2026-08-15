// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reasoningEffortsOf,
  reasoningLevelsOf,
  ReasoningEffortsField,
} from '../src/client/ReasoningEffortsField.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

const t = (key: keyof typeof zh, params?: Record<string, string>): string => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? String(key)
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

afterEach(cleanup)

describe('reasoning effort helpers', () => {
  it('derives the ticked set from a stored reasoningEfforts dict', () => {
    expect(reasoningLevelsOf({ reasoningEfforts: { off: null, low: 'low', high: 'high' } }))
      .toEqual(new Set(['off', 'low', 'high']))
    expect(reasoningLevelsOf({ reasoningEfforts: 'bad' })).toBeUndefined()
    expect(reasoningLevelsOf({})).toBeUndefined()
  })

  it('spells the wire dict: levels send their own name, off sends nothing', () => {
    expect(reasoningEffortsOf(new Set(['off', 'minimal', 'max'])))
      .toEqual({ off: null, minimal: 'minimal', max: 'max' })
  })
})

describe('ReasoningEffortsField', () => {
  it('shows the unset state and opens a popover with every level and select-all/clear', () => {
    const onChange = vi.fn()
    render(<ReasoningEffortsField levels={undefined} onChange={onChange} t={t} disabled={false} />)
    expect(screen.getByRole('button', { name: /未设置/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /未设置/ }))
    expect(screen.getByRole('checkbox', { name: /关闭/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /超高/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /最大/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '全选' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清空' })).toBeTruthy()
  })

  it('ticking one level writes the wire dict and keeps the summary in sync', () => {
    const onChange = vi.fn()
    render(<ReasoningEffortsField
      levels={new Set(['off'])}
      onChange={onChange}
      t={t}
      disabled={false}
    />)
    fireEvent.click(screen.getByRole('button', { name: /已选 1 档/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /低/ }))
    expect(onChange).toHaveBeenCalledWith({ off: null, low: 'low' })
  })

  it('select all ticks every level, clear removes the field', () => {
    const onChange = vi.fn()
    render(<ReasoningEffortsField levels={undefined} onChange={onChange} t={t} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: /未设置/ }))
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(onChange).toHaveBeenCalledWith({
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('unchecking the last level removes the field instead of storing an empty dict', () => {
    const onChange = vi.fn()
    render(<ReasoningEffortsField
      levels={new Set(['off'])}
      onChange={onChange}
      t={t}
      disabled={false}
    />)
    fireEvent.click(screen.getByRole('button', { name: /已选 1 档/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /关闭/ }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('disables every control while the card is read-only', () => {
    render(<ReasoningEffortsField levels={undefined} onChange={vi.fn()} t={t} disabled />)
    expect((screen.getByRole('button', { name: /未设置/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
