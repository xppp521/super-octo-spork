# 完全退出并重新启动 DeepSeek Harness。
#
# 为什么需要脚本：关掉窗口只是隐藏，托盘/后台进程仍然持有宿主；插件的新 bundle 层
# 只有在宿主进程重新起来时才会被加载（刷新页面没用）。
#
# 用法：右键 → 使用 PowerShell 运行；或在本目录执行  pwsh -File .\restart-harness.ps1

$exe = 'C:\Users\lsy\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

if (-not (Test-Path $exe)) {
    Write-Host "找不到 Harness 可执行文件：$exe" -ForegroundColor Red
    Write-Host "请手动退出并重新打开 DeepSeek Harness。" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
}

$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host ("正在结束 {0} 个 Harness 进程…" -f @($procs).Count) -ForegroundColor Cyan
    foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
} else {
    Write-Host "当前没有正在运行的 Harness 进程。" -ForegroundColor Cyan
}

Write-Host "正在重新启动…" -ForegroundColor Cyan
Start-Process $exe

Write-Host "`n已启动。等界面出来后，插件应已生效：" -ForegroundColor Green
Write-Host "  · 左侧会话行悬停 → 行尾出现垃圾桶按钮"
Write-Host "  · 会话行 ... 菜单 → 多一项「删除会话」"
Write-Host "`n如果想确认宿主侧路由是否已加载，可在浏览器打开：" -ForegroundColor DarkGray
Write-Host "  http://127.0.0.1:19387/dsh-session-delete/status" -ForegroundColor DarkGray
Start-Sleep -Seconds 2
