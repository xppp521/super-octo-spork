/**
 * Static checks for the browser half, mirroring what the plugin market's own
 * `verify.js` does (a classic-script syntax check) plus the loader's two hard
 * identity rules. Run with: node test/client-bundle-check.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'client', 'client.js')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(bundlePath, 'utf8')

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else {
    console.log(`FAIL ${label} ${detail}`)
    failures.push(label)
  }
}

// 1. The market compiles the bundle as a classic script; ESM syntax there means
//    the file would silently never run.
try {
  new vm.Script(source, { filename: 'client.js' })
  check('bundle 可作为经典脚本编译', true)
} catch (error) {
  check('bundle 可作为经典脚本编译', false, error.message)
}
check('不含顶层 import/export', !/^\s*(import|export)\s/m.test(source))

// 2. The loader requires `id` to equal the package name.
const idMatch = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
check('声明了 __ModuleLoader__.load', idMatch !== null)
check('wrapper id 等于包名', idMatch?.[1] === manifest.name, `${idMatch?.[1]} vs ${manifest.name}`)

// 3. The host resolves the browser artifact through exports["./client"].
const clientExport = manifest.exports?.['./client']
check('exports["./client"] 存在', typeof clientExport === 'string', JSON.stringify(clientExport))
check('dsh.client.platform = web', manifest.dsh?.client?.platform === 'web')
check('dsh.bundle.patch 声明了补丁文件', typeof manifest.dsh?.bundle?.patch === 'string')

// 4. Only baseline module names may be required without dsh.client.external.
const baseline = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
])
const declared = new Set(manifest.dsh?.client?.external ?? [])
const required = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])
const offenders = required.filter((name) => !baseline.has(name) && !declared.has(name))
check('require 仅使用基线模块', offenders.length === 0, offenders.join(', '))

console.log(`\nrequire 到的模块: ${[...new Set(required)].join(', ')}`)
console.log(failures.length === 0 ? '全部通过 ✅' : `失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
