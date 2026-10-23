import { isShow69Command, parseShow69Command, type Show69RecordInput } from './show69'

const product = '(?:(?:MAX|芭提雅|芭堤雅)\\s*){0,2}泰拳(?:比赛|表演|门票|拳赛|独立记录)?(?:\\s*(?:VVIP|VIP|普通票|成人票|儿童票|亚洲面孔|欧美面孔))?(?:\\s*[/／·—-]?\\s*月结[返反]佣)?(?:\\s*[（(]\\s*(?:亚洲面孔|欧美面孔)\\s*[）)])?'
const boundary = '[\\s,，;；、:：|]'
const names = /(?:客户姓名|姓名|名字|客户)(?:\s*\(\s*所有人\s*\))?\s*[:：]?/

// Protect the whole explicitly labelled customer field when handling project
// markers. In particular, a customer named “泰拳” must never be removed.
const outsideNames = (text: string, transform: (prefix: string) => string) => text.split('\n').map(line => {
  const label = names.exec(line)
  return label ? transform(line.slice(0, label.index)) + line.slice(label.index) : transform(line)
}).join('\n')
const withoutNames = (text: string) => text.split('\n').map(line => {
  const label = names.exec(line)
  return label ? line.slice(0, label.index) : line
}).join('\n')

export const isBoxingProject = (name: string): boolean => new RegExp(`^(?:${product})(?:\\s*[（(·/／—-].*)?$`, 'i').test(name.normalize('NFKC').trim())

export const isBoxingCommand = (text: string): boolean => {
  const content = withoutNames(text.normalize('NFKC').replace(/(?:备注|说明|\bnote\s*:)\s*[:：]?\s*[\s\S]*$/i, ''))
  return new RegExp(`(?:^|${boundary})(?:${product})(?=$|${boundary}|(?:出票|记录)?格式)`, 'i').test(content)
}

// Reuse the existing strict date/name/headcount parser. Only standalone product
// labels outside customer fields are translated to its internal product label.
export function parseBoxingCommand(text: string, today?: string): Show69RecordInput {
  const normalized = text.normalize('NFKC')
  const labels = withoutNames(normalized)
  if (isShow69Command(labels) || new RegExp(`(?:^|${boundary})泰拳(?:课程|培训|教学)(?=$|${boundary})`, 'i').test(labels)) {
    throw new Error('这里仅记录泰拳，请核对项目名称。')
  }
  const marker = new RegExp(`(^|${boundary})(?:${product})(?=$|${boundary}|(?:出票|记录)?格式)`, 'gi')
  const prepared = outsideNames(normalized, prefix => prefix.replace(marker, '$1' + '69'))
  try { return parseShow69Command(prepared, today) }
  catch (error) {
    if (error instanceof Error) throw new Error(error.message.replaceAll('69秀', '泰拳'))
    throw error
  }
}
