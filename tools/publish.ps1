# Creates the GitHub repo (if needed) and pushes this folder.
# Uses the Windows-stored git credential in memory only; never prints the secret.
$ErrorActionPreference = 'Continue'
$git = 'C:\Program Files\Git\cmd\git.exe'
$root = Split-Path -Parent $PSScriptRoot
$repoName = 'vibe-desktop'
$owner = 'compassRy'

# --- get credential from git credential manager (captured, not displayed) ---
$fillOut = "protocol=https`nhost=github.com`n`n" | & $git credential fill 2>$null
$username = ($fillOut | Select-String '^username=' | ForEach-Object { $_.Line.Substring(9) })
$password = ($fillOut | Select-String '^password=' | ForEach-Object { $_.Line.Substring(9) })
if (-not $password) { Write-Output 'NO_CREDENTIAL'; exit 1 }
Write-Output "credential user: $username"

$headers = @{ Authorization = "token $password"; 'User-Agent' = 'vibe-desktop-publish'; 'Accept' = 'application/vnd.github+json' }

# --- create repo if missing ---
$repoUrl = "https://api.github.com/repos/$owner/$repoName"
$exists = $null
try {
  $exists = Invoke-RestMethod -Uri $repoUrl -Headers $headers -Method GET
  Write-Output "repo already exists: $($exists.full_name)"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 404) {
    $body = @{
      name = $repoName
      description = 'Desktop app for Mistral Vibe — Electron GUI over vibe-app-server JSON-RPC (chat, tool approvals, model switching, session history, local file editing).'
      private = $false
      auto_init = $false
    } | ConvertTo-Json
    $created = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Headers $headers -Method POST -Body $body -ContentType 'application/json'
    Write-Output "created: $($created.full_name)  $($created.html_url)"
  } else {
    Write-Output "API error: $($_.Exception.Message)"
    exit 1
  }
}

# --- git init / commit / push ---
Set-Location $root
& $git init -b main 2>$null | Out-Null
& $git config user.name $owner
& $git config user.email "$owner@users.noreply.github.com"
& $git add -A
& $git commit -m "Vibe Desktop v0.1.0 — Electron GUI for Mistral Vibe (vibe-app-server JSON-RPC)

- chat UI with markdown, tool-call cards, approval dialogs
- model/thinking switcher, agent selector, YOLO toggle
- project/session sidebar with resume/continue
- local file editing in the opened folder
- localhost automation HTTP API (tools/gui.js)
- dark/light/system themes
- README with usage and protocol notes" | Out-Null
$remote = "https://github.com/$owner/$repoName.git"
& $git remote remove origin 2>$null
& $git remote add origin $remote 2>$null
if ((& $git remote) -notcontains 'origin') { & $git remote add origin $remote }
$env:GIT_TERMINAL_PROMPT = '0'
& $git push -u origin main 2>&1 | ForEach-Object { Write-Output $_ }
Write-Output "PUSH_DONE"
