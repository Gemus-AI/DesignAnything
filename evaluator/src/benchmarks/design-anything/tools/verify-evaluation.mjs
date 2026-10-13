// 打完分之后反查结果是否成立。**不看「有没有报错」，看结果本身。**
//
// 2026-09-18 的教训：旁挂权重指错时，打分照常跑完、退出码 0、日志只有一行提示，
// 而风格那一列整批是空的。`csdWeightsSha256` 又不在 `evaluatorIdentity()` 里，
// 比较器不会拒表 —— 也就是说那一批坏读数没有任何自动保护，只能靠事后反查。
//
// 用法：
//   node verify-evaluation.mjs <导出包目录> [--expect <份数>] [--dq] [--weights]
//
//   --expect   期望出几份 evaluation.json；缺省按目录里带 manifest.json 的 run 数
//   --dq       本轮带了 --dq，于是每份都该有 dqChecklistSha
//   --weights  本轮配了 BENCH_CSD_WEIGHTS，于是风格列不该是 unavailable
//              （没配时 unavailable 是合法降级，不算故障）
//
// 退出码 0 = 通过，1 = 有问题（问题逐条打到 stderr）。
import fs from 'node:fs'
import path from 'node:path'

/** 一份包的关键字段；读不出来的用 null，不猜 */
function readPack(dir) {
  const file = path.join(dir, 'evaluation.json')
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return {
    styleStatus: parsed.score?.styleConsistency?.status ?? null,
    dqChecklistSha: parsed.dqChecklistSha ?? null,
    identity: [
      parsed.evaluatorVersion ?? 'none',
      parsed.taskSetSha ?? 'none',
      parsed.dqChecklistSha ?? 'none',
    ].join('|'),
  }
}

/**
 * @param {string} root 导出包目录
 * @param {{expect?: number, dq?: boolean, weights?: boolean}} options
 * @returns {{summary: string[], problems: string[]}}
 */
export function verifyEvaluation(root, options = {}) {
  const runDirs = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
  const expect = options.expect ?? runDirs.length

  const style = { measured: 0, 'not-applicable': 0, unavailable: 0 }
  const identities = new Set()
  let done = 0
  let missingDq = 0
  for (const dir of runDirs) {
    const pack = readPack(dir)
    if (!pack) continue
    done++
    if (pack.styleStatus && pack.styleStatus in style) style[pack.styleStatus]++
    if (options.dq && !pack.dqChecklistSha) missingDq++
    identities.add(pack.identity)
  }

  const summary = [
    `evaluation.json  ${done}/${expect}`,
    `风格列           measured ${style.measured} · not-applicable ${style['not-applicable']} · unavailable ${style.unavailable}`,
    `尺子身份         ${identities.size} 种`,
  ]

  const problems = []
  if (done !== expect) problems.push(`只出了 ${done}/${expect} 份 evaluation.json`)
  // 没配权重时 unavailable 是「这台机器没装」，是合法状态；配了还 unavailable 才是故障
  if (options.weights && style.unavailable > 0) {
    problems.push(`${style.unavailable} 份的风格列是 unavailable —— 权重变量设了却没加载成功`)
  }
  if (missingDq > 0) problems.push(`${missingDq} 份没有 dqChecklistSha（带了 --dq 但 M3 没判）`)
  if (identities.size > 1) problems.push(`尺子身份有 ${identities.size} 种，这批不能进同一张表`)
  return { summary, problems }
}

function main() {
  const [root, ...rest] = process.argv.slice(2)
  if (!root) {
    console.error('用法: node verify-evaluation.mjs <导出包目录> [--expect <份数>] [--dq] [--weights]')
    process.exit(2)
  }
  const expectIndex = rest.indexOf('--expect')
  const { summary, problems } = verifyEvaluation(root, {
    expect: expectIndex === -1 ? undefined : Number(rest[expectIndex + 1]),
    dq: rest.includes('--dq'),
    weights: rest.includes('--weights'),
  })
  for (const line of summary) console.log(`  ${line}`)
  if (problems.length > 0) {
    console.error('\n' + problems.map((p) => `✗ ${p}`).join('\n'))
    process.exit(1)
  }
  console.log('\n✓ 反查通过')
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) main()
