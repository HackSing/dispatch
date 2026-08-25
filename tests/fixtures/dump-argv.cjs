// 测试 fixture:把收到的命令行参数以 JSON 写 stdout。
// 由临时目录里的 echo-args.cmd 经 %* 转发调用 —— batch 的 echo 会对展开后的 & 等元字符
// 二次解释,无法无损回显,故用 node 原样 dump argv(platform-win32 buildSpawn 验证用)
process.stdout.write(JSON.stringify(process.argv.slice(2)))
