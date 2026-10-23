import { useEffect, useRef, useState } from 'react'
import type { Project, TicketInput } from '../types'
import { applyTicketCommand, parseTicketCommand, type ParsedTicketCommand } from '../lib/ticket-command'
import { quantityLabels } from '../lib/quantity'
import { isShow69Command, parseShow69Command, type Show69RecordInput } from '../lib/show69'
import { isBoxingCommand, parseBoxingCommand } from '../lib/boxing'

export function TicketQuickFill({ projects, current, disabled, onFill, onBusyChange, onShow69, onBoxing }: {
  projects: Project[]
  current: TicketInput
  disabled: boolean
  onFill: (input: TicketInput) => void
  onBusyChange: (busy: boolean) => void
  onShow69?: (input: Show69RecordInput) => void
  onBoxing?: (input: Show69RecordInput) => void
}) {
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [pending, setPending] = useState<ParsedTicketCommand | null>(null)
  const [pasting, setPasting] = useState(false)
  const request = useRef(0)
  const pasteLock = useRef(false)
  const latest = useRef({ projects, current, disabled })
  latest.current = { projects, current, disabled }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => () => { request.current++ }, [])

  const cancelRead = () => {
    request.current++
    pasteLock.current = false
    setPasting(false)
    onBusyChange(false)
  }
  const clearFeedback = () => { setError(''); setMessage(''); setWarnings([]); setPending(null) }

  const apply = (parsed: ParsedTicketCommand, chosen: Project) => {
    const project = latest.current.projects.find(row => row.id === chosen.id && !row.mergedIntoId)
    if (!project) throw new Error('这个套餐已更新，请重新识别。')
    const next = applyTicketCommand(latest.current.current, parsed, project)
    onBusyChange(false)
    onFill(next)
    setPending(null)
    setWarnings(parsed.warnings)
    setMessage(`已填入：${next.projectName}${next.subItemName ? ` · ${next.subItemName}` : ''} · ${next.guestName?.trim() || '姓名未填'} · ${next.issueDate.replaceAll('-', '/')} · ${next.personCount ?? '未填'}${quantityLabels(next).unit}。请核对后保存。`)
  }

  const fill = (text: string) => {
    if (latest.current.disabled) return
    cancelRead(); clearFeedback()
    try {
      const show69 = Boolean(onShow69) && isShow69Command(text)
      const boxing = Boolean(onBoxing) && isBoxingCommand(text)
      if (show69 && boxing) throw new Error('检测到多个项目，请每次只填写一个项目。')
      if (onShow69 && show69) {
        const input = parseShow69Command(text)
        onBusyChange(false)
        onShow69(input)
        return
      }
      if (onBoxing && boxing) {
        const input = parseBoxingCommand(text)
        onBusyChange(false)
        onBoxing(input)
        return
      }
      const parsed = parseTicketCommand(text, latest.current.projects)
      if (parsed.candidates.length === 1) apply(parsed, parsed.candidates[0])
      else { setPending(parsed); setWarnings(parsed.warnings); onBusyChange(true) }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '未能识别，请补充项目、日期、姓名和人数。') }
  }

  const pasteAndFill = async () => {
    if (disabled || pasteLock.current) return
    cancelRead()
    clearFeedback()
    if (!navigator.clipboard?.readText) {
      setError('当前浏览器无法直接读取剪贴板。请长按输入框黏贴，系统会自动识别。')
      inputRef.current?.focus()
      return
    }
    const version = ++request.current
    pasteLock.current = true; setPasting(true); onBusyChange(true)
    try {
      const text = await navigator.clipboard.readText()
      if (version !== request.current) return
      if (!text.trim()) { setError('剪贴板没有文字，请先复制订单内容。'); return }
      setCommand(text)
      fill(text)
    } catch {
      if (version === request.current) {
        setError('未能读取剪贴板。请允许浏览器黏贴，或长按输入框黏贴，系统会自动识别。')
        inputRef.current?.focus()
      }
    } finally {
      if (version === request.current) { pasteLock.current = false; setPasting(false); onBusyChange(false) }
    }
  }

  return <section className="ticket-quick-fill" aria-label="订单自动填写">
    <label>一句话填写<textarea ref={inputRef} disabled={disabled} rows={3} value={command} placeholder="例如：79秀 Jimmy 今天 2人；也可写套餐、供货商、售价和成本" onChange={event => { cancelRead(); setCommand(event.target.value); clearFeedback() }} onPaste={event => {
      if (disabled) return
      const text = event.clipboardData.getData('text/plain')
      if (!text.trim()) return
      event.preventDefault(); setCommand(text); fill(text)
    }} /></label>
    <div className="quick-fill-actions"><button className="secondary-button" type="button" disabled={disabled || pasting} aria-busy={pasting} onClick={() => void pasteAndFill()}>{pasting ? '正在黏贴…' : '黏贴/自动填入'}</button>{command.trim() && <button className="text-action" type="button" disabled={disabled || pasting} onClick={() => fill(command)}>识别当前文字</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="quick-fill-result" role="status">{message}</p>}
    {pending && <div className="quick-fill-candidates"><p role="status">匹配到多个套餐，请选择后填入：</p>{pending.candidates.map(project => <button type="button" className="secondary-button" disabled={disabled || pasting} key={project.id} onClick={() => {
      setError('')
      try { apply(pending, project) } catch (failure) { setError(failure instanceof Error ? failure.message : '填入失败，请重新识别。') }
    }}>{project.name} · {project.subItemName || '不分套餐'} · {project.supplierName}</button>)}<button type="button" className="text-action" disabled={disabled || pasting} onClick={() => { cancelRead(); clearFeedback() }}>取消匹配，手动填写</button></div>}
    {warnings.length > 0 && <div className="quick-fill-warnings" role="status">{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    <p className="muted">按系统价格表匹配，填入后可修改。核对姓名、日期、套餐及金额后，再点“保存记录”。</p>
  </section>
}
