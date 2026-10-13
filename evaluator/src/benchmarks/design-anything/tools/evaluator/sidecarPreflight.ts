/**
 * 旁挂权重的配置自检 —— 在烧任何判官 token 之前跑一次。
 *
 * ## 要解决的是哪件事
 *
 * CSD 与 DINO 两个侧车在权重加载失败时都返回 `status: 'unavailable'` **而不抛**，
 * 这是刻意的：一列诊断读数不该把整轮评估打死，没装权重的机器照样要能打分。
 *
 * 但这条设计把两种完全不同的情形合并成了同一个结果：
 *
 * | 情形 | 该怎样 |
 * |---|---|
 * | 这台机器**没装**权重（env 没设） | 继续跑，该列记 `unavailable` |
 * | 装了、但 env **指错了** | **是操作错误，应当当场停** |
 *
 * 第二种情形现在只留下日志里一行 `! style sidecar unavailable`，退出码仍是 0，
 * 而 `csdWeightsSha256` 不在 {@link evaluatorIdentity} 里 —— 比较器不会拒表，
 * **没有任何自动保护**。2026-09-18 一整轮 20 格打分因此作废重跑。
 *
 * 所以本模块只管第二种：**env 设了就必须指得对**，指不对在 `main()` 开头就抛。
 * env 没设一律放行，优雅降级那条路原样保留。
 *
 * ## 两个变量的粒度不一样，这正是当时踩的坑
 *
 * - `BENCH_CSD_WEIGHTS` 要的是**权重文件本身**（`.../csd-vit-l/pytorch_model.bin`）
 * - `BENCH_DINO_WEIGHTS` 要的是**目录**（`.../grounding-dino-tiny`）
 *
 * 两个都指到公共父目录 `<weights-dir>` 看上去很自然，实际两个都加载不了。
 * 所以下面识别出这一情形时，直接把该填的值算给使用者，不让人自己猜。
 */
import fs from 'node:fs'
import path from 'node:path'

/** CSD 权重在发布目录里的相对位置 —— 用来在「指到了父目录」时算出正确值 */
const CSD_LEAF = path.join('csd-vit-l', 'pytorch_model.bin')
/** DINO 权重目录名，同上 */
const DINO_LEAF = 'grounding-dino-tiny'
/** DINO 权重目录里必须有的那个文件；只有目录名对、内容不对时用它识别 */
const DINO_REQUIRED_FILE = 'model.safetensors'

export interface SidecarPreflightIssue {
  /** 出问题的环境变量名 */
  variable: 'BENCH_CSD_WEIGHTS' | 'BENCH_DINO_WEIGHTS'
  /** 使用者当前给的值 */
  value: string
  /** 一句话说清哪里不对 */
  problem: string
  /** 能算出正确值时给出；算不出时为 null（比如路径压根不存在） */
  suggestion: string | null
}

function issue(
  variable: SidecarPreflightIssue['variable'],
  value: string,
  problem: string,
  suggestion: string | null,
): SidecarPreflightIssue {
  return { variable, value, problem, suggestion }
}

function checkCsd(value: string): SidecarPreflightIssue | null {
  if (!fs.existsSync(value)) {
    return issue('BENCH_CSD_WEIGHTS', value, '路径不存在', null)
  }
  if (!fs.statSync(value).isDirectory()) return null // 是个文件，交给侧车自己按 sha 校验

  // 指到了目录。若它下面就是发布结构，直接把该填的值算出来。
  const leaf = path.join(value, CSD_LEAF)
  return issue(
    'BENCH_CSD_WEIGHTS',
    value,
    `要的是权重文件本身，给的是目录`,
    fs.existsSync(leaf) ? leaf : null,
  )
}

function checkDino(value: string): SidecarPreflightIssue | null {
  if (!fs.existsSync(value)) {
    return issue('BENCH_DINO_WEIGHTS', value, '路径不存在', null)
  }
  if (!fs.statSync(value).isDirectory()) {
    return issue('BENCH_DINO_WEIGHTS', value, '要的是目录，给的是文件', path.dirname(value))
  }
  if (fs.existsSync(path.join(value, DINO_REQUIRED_FILE))) return null

  // 目录存在但不是权重目录 —— 多半是指到了公共父目录
  const leaf = path.join(value, DINO_LEAF)
  return issue(
    'BENCH_DINO_WEIGHTS',
    value,
    `目录里没有 ${DINO_REQUIRED_FILE}`,
    fs.existsSync(path.join(leaf, DINO_REQUIRED_FILE)) ? leaf : null,
  )
}

/**
 * 检查两个侧车权重变量。**没设的变量一律跳过** —— 那是「这台机器没装」，不是错误。
 *
 * @param env 注入点，缺省读 `process.env`
 */
export function checkSidecarWeights(env: NodeJS.ProcessEnv = process.env): SidecarPreflightIssue[] {
  const issues: SidecarPreflightIssue[] = []
  const csd = env.BENCH_CSD_WEIGHTS
  if (csd) {
    const found = checkCsd(csd)
    if (found) issues.push(found)
  }
  const dino = env.BENCH_DINO_WEIGHTS
  if (dino) {
    const found = checkDino(dino)
    if (found) issues.push(found)
  }
  return issues
}

/** 把自检结果渲染成可直接照做的错误文本。`issues` 为空时返回 null。 */
export function formatSidecarPreflight(issues: readonly SidecarPreflightIssue[]): string | null {
  if (issues.length === 0) return null
  const lines = [
    '旁挂权重配置不对，已在打分开始前停下（继续跑会让风格 / 检测那几列静默空着，而退出码仍是 0）：',
    '',
  ]
  for (const item of issues) {
    lines.push(`  ${item.variable}=${item.value}`)
    lines.push(`    ${item.problem}`)
    if (item.suggestion) lines.push(`    应为：${item.suggestion}`)
    lines.push('')
  }
  lines.push('两个变量的粒度不同，这是最常踩的一处：')
  lines.push(`  BENCH_CSD_WEIGHTS  要权重文件本身（.../${CSD_LEAF.replace(/\\/g, '/')}）`)
  lines.push(`  BENCH_DINO_WEIGHTS 要目录（.../${DINO_LEAF}）`)
  lines.push('')
  lines.push('确实不想跑侧车就把这两个变量一起 unset —— 没设时评估照常进行，该列记 unavailable。')
  return lines.join('\n')
}
