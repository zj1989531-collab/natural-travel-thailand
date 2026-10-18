import logoUrl from '../assets/natural-travel-thailand-logo.jpg'
import { validateShow79Voucher, voucherDate, type Show79VoucherInput } from './show79'

export const SHOW79_TIME = '18:30–21:30【循环表演】'

export async function createShow79Voucher(input: Show79VoucherInput): Promise<Blob> {
  validateShow79Voucher(input)
  await document.fonts.ready
  const logo = new Image()
  logo.src = logoUrl
  await logo.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 1080; canvas.height = 1512
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法生成图片，请换用手机浏览器。')
  ctx.fillStyle = '#f0fff0'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111'
  const font = 'Arial, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  const text = (value: string, x: number, y: number, size = 30, bold = false, maxWidth?: number) => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${font}`
    if (maxWidth) while (ctx.measureText(value).width > maxWidth && size > 15) { size--; ctx.font = `${bold ? 'bold ' : ''}${size}px ${font}` }
    if (maxWidth) ctx.fillText(value, x, y, maxWidth)
    else ctx.fillText(value, x, y)
  }
  const centeredText = (value: string, y: number, size = 42, maxWidth = 490, x = canvas.width / 2) => {
    ctx.save()
    ctx.textAlign = 'center'
    text(value, x, y, size, true, maxWidth)
    ctx.restore()
  }
  const line = (y: number, x = 36, end = 1035) => { ctx.beginPath(); ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.moveTo(x, y); ctx.lineTo(end, y); ctx.stroke() }
  // Use the company's original logo asset rather than redrawing the branding.
  // The source is a square JPG with white margins above and below the logo.
  // Crop those margins while retaining the mark's original aspect ratio.
  ctx.globalCompositeOperation = 'multiply'
  ctx.drawImage(logo, 0, 165, 498, 205, 45, 50, 435, 435 * 205 / 498)
  ctx.globalCompositeOperation = 'source-over'
  text('VOUCHER NO.', 640, 95, 23, true); text('预订单号', 640, 125, 25, true)
  text('TRAVEL DATE', 635, 180, 23, true); text('观看日期', 635, 211, 25, true)
  centeredText(voucherDate(input.date), 211, 33, 225, (810 + 1035) / 2); line(223, 635)
  const heading = 'CONFIRM ORDER 确认订单'
  ctx.font = `bold 38px ${font}`; const headingX = (1080 - ctx.measureText(heading).width) / 2
  text(heading, headingX, 335, 38, true); line(342, headingX, 1080 - headingX)
  const row = (en: string, zh: string, value: string, top: number, bottom: number, size = 42) => {
    text(en, 38, top, 25, true); text(zh, 38, top + 33, 27, true)
    centeredText(value, bottom - 23, size); line(bottom)
  }
  row('PRODUCT NAME', '产品名称', '79 秀', 430, 505)
  row('PACKAGE', '产品套餐', '门票', 548, 624)
  row('GUEST NAME', '客户姓名', input.guestName.trim(), 666, 742)
  row('PASSPORT NO.', '护照号', '-', 786, 862, 30)
  row('QUANTITY', '出行人数', `${input.people}人`, 904, 978)
  text('TIME', 35, 1023, 25, true); text('时间场次', 35, 1058, 27, true)
  centeredText(SHOW79_TIME, 1058, 37, 685); line(1077)
  row('CONTACT', '联系方式', '-', 1115, 1170, 30)
  text('REMARKS', 35, 1210, 25, true); text('备注说明', 35, 1245, 27, true)
  centeredText('打车英文名称【IMAGINE 79SHOW】', 1245, 35, 720); line(1265)
  text('重要说明 (Important information)', 43, 1310, 21); line(1315, 43, 370)
  const footer = [
    '1. 收到订单后,请仔细核对您的出行信息,如有误请及时联系客服更改',
    '2. 订单仅当日可用,一经确认不可退改',
    '3. 如因个人原因造成预定日期、人数、预定内容不符,信息错误,并未经过沟通确认,',
    '出票当天没法凭电子订单换票入场,以及未经过沟通确认支付额外费用给景点,',
    '事后处理取证困难,造成的损失自行承担'
  ]
  footer.forEach((value, index) => text(value, 45, 1370 + index * 28, 22, false, 985))
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败，请重试。')), 'image/png'))
}

export const voucherFilename = (input: Show79VoucherInput) => `79秀_${voucherDate(input.date).replaceAll('/', '-')}_${input.guestName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.png`

export function downloadVoucher(url: string, filename: string) {
  const link = document.createElement('a'); link.href = url; link.download = filename
  document.body.append(link); link.click(); link.remove()
}

export function printVoucher(url: string) {
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('浏览器阻止了打印窗口，请允许弹出窗口或先下载图片。')
  popup.opener = null
  popup.document.title = '79秀确认单'
  const style = popup.document.createElement('style')
  style.textContent = '@page { size: A4; margin: 10mm; } body { margin: 0; } img { display: block; width: 100%; max-height: 275mm; object-fit: contain; }'
  popup.document.head.append(style)
  const image = popup.document.createElement('img')
  image.alt = '79秀确认单'
  image.onload = () => { popup.focus(); popup.print() }
  image.src = url
  popup.document.body.append(image)
}
