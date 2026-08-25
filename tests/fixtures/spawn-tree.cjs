// 测试 fixture:拉起一个常驻孙进程后自身常驻,把父/孙 pid 以 JSON 写入 argv[2] 指定的文件
// (platform-win32 killTree 验证整树强杀用)
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
child.on('error', () => {})
fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }))
setTimeout(() => {}, 600000)
